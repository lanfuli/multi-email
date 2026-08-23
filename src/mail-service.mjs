import { createHash } from "node:crypto";
import {
  diagnosticRecord,
  unexpectedDiagnosticRecord,
} from "./connection-diagnostic.mjs";
import { GmailProvider } from "./providers/gmail.mjs";
import { MicrosoftProvider } from "./providers/microsoft.mjs";
import { findAccount } from "./config.mjs";
import { HARD_SAFETY_LIMITS } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";
import { normalizeAddresses } from "./mime.mjs";
import {
  EFFECTIVE_SEND_MANIFEST_VERSION,
  EFFECTIVE_SEND_POLICY_VERSION,
  SendApprovalStore,
} from "./send-approval.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const PUBLIC_ERROR_CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const PRE_SEND_TRANSPORT_CODES = new Set([
  "ABORT_ERR",
  "AbortError",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "GOOGLE_NETWORK_ERROR",
  "GOOGLE_REQUEST_TIMEOUT",
  "MICROSOFT_NETWORK_ERROR",
  "MICROSOFT_REQUEST_ABORTED",
  "MICROSOFT_TIMEOUT",
  "OPERATION_DEADLINE_EXCEEDED",
  "TimeoutError",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function safePublicErrorCode(value, fallback = "PROVIDER_ERROR") {
  const code = typeof value === "string" ? value.trim() : "";
  return PUBLIC_ERROR_CODE.test(code) ? code : fallback;
}

function isKnownPreSendTransportFailure(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (
      PRE_SEND_TRANSPORT_CODES.has(String(current.code || "")) ||
      PRE_SEND_TRANSPORT_CODES.has(String(current.name || ""))
    ) {
      return true;
    }
    current = current.cause || current.error;
  }
  return false;
}

function boundedSafety(config) {
  const configured = config.safety || {};
  const safety = {};
  for (const [key, hardLimit] of Object.entries(HARD_SAFETY_LIMITS)) {
    const value = configured[key] ?? hardLimit;
    if (!Number.isInteger(value) || value <= 0) {
      throw new MultiEmailError(`safety.${key} must be a positive integer.`, "INVALID_CONFIG");
    }
    safety[key] = Math.min(value, hardLimit);
  }
  return safety;
}

function requireString(value, field, { allowEmpty = false, maxLength = 4096 } = {}) {
  if (typeof value !== "string") {
    throw new MultiEmailError(`${field} must be a string.`, "INVALID_INPUT");
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw new MultiEmailError(`${field} is required.`, "INVALID_INPUT");
  }
  if (value.length > maxLength) {
    throw new MultiEmailError(`${field} is too long.`, "INVALID_INPUT");
  }
  return value;
}

function requireIds(values, field, maxCount) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new MultiEmailError(`${field} must contain at least one ID.`, "INVALID_INPUT");
  }
  if (values.length > maxCount) {
    throw new MultiEmailError(
      `${field} exceeds the configured batch limit of ${maxCount}.`,
      "SAFETY_LIMIT",
    );
  }
  const unique = [...new Set(values.map((value) => requireString(value, field, { maxLength: 1024 })))]
    .filter(Boolean);
  if (unique.length !== values.length) {
    throw new MultiEmailError(`${field} contains duplicate or empty IDs.`, "INVALID_INPUT");
  }
  return unique;
}

function validateBody(body) {
  requireString(body, "body", { allowEmpty: true, maxLength: MAX_BODY_BYTES });
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new MultiEmailError("Draft body exceeds the 1 MB safety limit.", "SAFETY_LIMIT");
  }
  return body;
}

function validateSubject(subject = "") {
  requireString(subject, "subject", { allowEmpty: true, maxLength: 998 });
  if (/\r|\n/.test(subject)) {
    throw new MultiEmailError("subject contains an invalid line break.", "INVALID_INPUT");
  }
  return subject;
}

function validateRecipients(input, maxRecipients, { requireAny = false } = {}) {
  const recipients = {
    to: normalizeAddresses(input.to || [], "to"),
    cc: normalizeAddresses(input.cc || [], "cc"),
    bcc: normalizeAddresses(input.bcc || [], "bcc"),
  };
  const total = recipients.to.length + recipients.cc.length + recipients.bcc.length;
  if (requireAny && total === 0) {
    throw new MultiEmailError("At least one recipient is required before sending.", "INVALID_INPUT");
  }
  if (total > maxRecipients) {
    throw new MultiEmailError(
      `Recipient count exceeds the configured limit of ${maxRecipients}.`,
      "SAFETY_LIMIT",
    );
  }
  return recipients;
}

function notReviewable(message) {
  throw new MultiEmailError(message, "DRAFT_NOT_REVIEWABLE");
}

function reviewIdentity(value, field, { allowEmpty = false } = {}) {
  if (allowEmpty && value === "") return "";
  if (typeof value !== "string" || !value) {
    notReviewable(`Draft ${field} identity is missing or incomplete.`);
  }
  try {
    return normalizeAddresses([value], field)[0];
  } catch {
    return notReviewable(`Draft ${field} identity is invalid.`);
  }
}

function reviewString(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value) {
    notReviewable(`Draft ${field} is missing from the provider review.`);
  }
  return value;
}

function reviewThreadHeader(value, field, { multiple = false } = {}) {
  if (typeof value !== "string") {
    notReviewable(`Draft ${field} state is missing from the provider review.`);
  }
  if (!value) return "";
  if (value.length > 4096 || /[\r\n]/u.test(value)) {
    notReviewable(`Draft ${field} header is invalid or too long.`);
  }
  const tokens = value.trim().split(/\s+/u).filter(Boolean);
  if ((!multiple && tokens.length !== 1) || !tokens.length) {
    notReviewable(`Draft ${field} header is invalid.`);
  }
  if (tokens.some((token) => !/^<[^<>\s]{1,900}>$/u.test(token))) {
    notReviewable(`Draft ${field} header contains an invalid message ID.`);
  }
  return tokens.join(" ");
}

function providerRevision(account, review, messageId, threadId) {
  const revision = {
    messageId,
    threadId,
    rawPayloadSha256: null,
    changeKey: null,
    lastModifiedDateTime: null,
  };
  if (
    typeof review.rawPayloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(review.rawPayloadSha256)
  ) {
    notReviewable("Provider draft review is missing its complete raw-payload revision hash.");
  }
  revision.rawPayloadSha256 = review.rawPayloadSha256;
  if (account.provider === "google") {
    return revision;
  }
  if (account.provider === "microsoft") {
    revision.changeKey = reviewString(review.changeKey, "change key");
    revision.lastModifiedDateTime = reviewString(
      review.lastModifiedDateTime,
      "last modified timestamp",
    );
    return revision;
  }
  return notReviewable(`Provider '${account.provider}' has no complete-draft review policy.`);
}

function canonicalDraftReview(account, draftId, review, maxRecipients) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    notReviewable("Provider returned an incomplete draft review.");
  }
  if (review.completeness !== "complete") {
    notReviewable("Draft review is incomplete and cannot be approved for sending.");
  }
  if (review.bodyFormat !== "text") {
    notReviewable("Only complete plain-text drafts can be approved for sending.");
  }
  if (!Array.isArray(review.attachments)) {
    notReviewable("Draft attachment state is missing from the provider review.");
  }
  if (review.attachments.length !== 0) {
    notReviewable("Drafts with attachments cannot be approved for sending.");
  }
  if (!Array.isArray(review.replyTo)) {
    notReviewable("Draft Reply-To state is missing from the provider review.");
  }
  if (![review.to, review.cc, review.bcc].every(Array.isArray)) {
    notReviewable("Draft recipient enumeration is missing from the provider review.");
  }
  if (typeof review.subject !== "string") {
    notReviewable("Draft subject state is missing from the provider review.");
  }

  const from = reviewIdentity(review.from, "From");
  const sender = reviewIdentity(review.sender, "Sender", { allowEmpty: true });
  let replyTo;
  try {
    replyTo = normalizeAddresses(review.replyTo, "reply-to");
  } catch {
    return notReviewable("Draft Reply-To identity is invalid.");
  }
  if (from !== account.email || (sender && sender !== account.email)) {
    notReviewable("Draft From and Sender must match the configured primary account identity.");
  }
  if (replyTo.length !== 0) {
    notReviewable("Drafts with an additional Reply-To identity cannot be approved for sending.");
  }

  const recipients = validateRecipients(review, maxRecipients, { requireAny: true });
  const messageId = reviewString(review.messageId, "message ID");
  const threadId = reviewString(review.threadId, "thread ID", { nullable: true });
  const body = validateBody(review.body);
  const inReplyTo = reviewThreadHeader(review.inReplyTo, "In-Reply-To");
  const references = reviewThreadHeader(review.references, "References", { multiple: true });
  return {
    manifestVersion: EFFECTIVE_SEND_MANIFEST_VERSION,
    policyVersion: EFFECTIVE_SEND_POLICY_VERSION,
    account: account.alias,
    provider: account.provider,
    authenticatedPrincipal: account.email,
    mailboxResource: account.email,
    draftId,
    messageId,
    threadId,
    from,
    sender,
    replyTo,
    ...recipients,
    subject: validateSubject(review.subject),
    inReplyTo,
    references,
    body,
    bodyFormat: "text",
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    attachments: [],
    completeness: "complete",
    providerRevision: providerRevision(account, review, messageId, threadId),
  };
}

function safePreview(body, maxCharacters = 4_000) {
  if (body.length <= maxCharacters) return { text: body, truncated: false };
  return { text: `${body.slice(0, maxCharacters)}\n\n[preview truncated]`, truncated: true };
}

export class MailService {
  constructor({ config, credentialStore, approvalStore, approvalUi, providers } = {}) {
    if (!config) throw new MultiEmailError("MailService requires config.", "INVALID_CONFIG");
    this.config = config;
    this.safety = boundedSafety(config);
    this.credentialStore = credentialStore;
    this.approvals =
      approvalStore ||
      new SendApprovalStore({ ttlSeconds: this.safety.sendApprovalTtlSeconds });
    this.approvalUi = approvalUi;
    this.providers =
      providers ||
      {
        google: new GmailProvider({ config, credentialStore }),
        microsoft: new MicrosoftProvider({ config, credentialStore }),
      };
  }

  account(alias) {
    return findAccount(this.config, alias);
  }

  provider(account) {
    const provider = this.providers[account.provider];
    if (!provider) {
      throw new MultiEmailError(`Provider '${account.provider}' is unavailable.`, "PROVIDER_UNAVAILABLE");
    }
    return provider;
  }

  async listAccounts() {
    return Promise.all(
      this.config.accounts.map(async (account) => {
        const credentialPresent = await this.provider(account).isAuthenticated(account);
        return {
          alias: account.alias,
          email: account.email,
          provider: account.provider,
          credentialPresent,
          connectionStatus: credentialPresent
            ? "credential_present_unverified"
            : "not_authorized",
        };
      }),
    );
  }

  async diagnoseAccounts(alias = undefined) {
    const accounts = alias === undefined ? this.config.accounts : [this.account(alias)];
    return Promise.all(
      accounts.map(async (account) => {
        try {
          const provider = this.provider(account);
          if (typeof provider.diagnose !== "function") {
            throw new MultiEmailError(
              `Diagnostics are not supported for provider '${account.provider}'.`,
              "UNSUPPORTED_OPERATION",
            );
          }
          return diagnosticRecord(account, await provider.diagnose(account));
        } catch (error) {
          return unexpectedDiagnosticRecord(account, error);
        }
      }),
    );
  }

  async verifyAccount(alias) {
    const account = this.account(alias);
    const profile = await this.provider(account).profile(account);
    const actualEmail = String(profile.email || "").toLowerCase();
    if (actualEmail !== account.email) {
      throw new MultiEmailError(
        `Authenticated identity '${actualEmail}' does not match '${account.email}'.`,
        "ACCOUNT_MISMATCH",
      );
    }
    return { account: account.alias, provider: account.provider, email: actualEmail, verified: true };
  }

  async search(alias, { query, maxResults, pageToken }) {
    const account = this.account(alias);
    const requested = maxResults ?? Math.min(10, this.safety.maxSearchResults);
    if (!Number.isInteger(requested) || requested < 1) {
      throw new MultiEmailError("max_results must be a positive integer.", "INVALID_INPUT");
    }
    if (requested > this.safety.maxSearchResults) {
      throw new MultiEmailError(
        `max_results exceeds the configured limit of ${this.safety.maxSearchResults}.`,
        "SAFETY_LIMIT",
      );
    }
    return this.provider(account).search(account, {
      query: requireString(query, "query", { maxLength: 2048 }),
      maxResults: requested,
      pageToken: pageToken || undefined,
    });
  }

  async getMessage(alias, messageId) {
    const account = this.account(alias);
    return this.provider(account).getMessage(
      account,
      requireString(messageId, "message_id", { maxLength: 1024 }),
    );
  }

  async createDraft(alias, input) {
    const account = this.account(alias);
    const recipients = validateRecipients(input, this.safety.maxRecipients);
    return this.provider(account).createDraft(account, {
      ...recipients,
      subject: validateSubject(input.subject || ""),
      body: validateBody(input.body || ""),
    });
  }

  async createReplyDraft(alias, input) {
    const account = this.account(alias);
    const recipients = validateRecipients(input, this.safety.maxRecipients);
    return this.provider(account).createReplyDraft(account, {
      messageId: requireString(input.messageId, "message_id", { maxLength: 1024 }),
      body: validateBody(input.body || ""),
      cc: recipients.cc,
      bcc: recipients.bcc,
    });
  }

  async updateDraft(alias, draftId, input) {
    const account = this.account(alias);
    const provider = this.provider(account);
    const normalizedDraftId = requireString(draftId, "draft_id", { maxLength: 1024 });
    if (!["to", "cc", "bcc", "subject", "body"].some((key) => input[key] !== undefined)) {
      throw new MultiEmailError("At least one draft field must be provided.", "INVALID_INPUT");
    }
    const patch = {};
    if (input.to !== undefined) patch.to = normalizeAddresses(input.to, "to");
    if (input.cc !== undefined) patch.cc = normalizeAddresses(input.cc, "cc");
    if (input.bcc !== undefined) patch.bcc = normalizeAddresses(input.bcc, "bcc");
    if (input.subject !== undefined) patch.subject = validateSubject(input.subject);
    if (input.body !== undefined) patch.body = validateBody(input.body);
    const current = await provider.reviewDraft(account, normalizedDraftId);
    validateRecipients(
      {
        to: patch.to ?? current.to,
        cc: patch.cc ?? current.cc,
        bcc: patch.bcc ?? current.bcc,
      },
      this.safety.maxRecipients,
    );
    return provider.updateDraft(account, normalizedDraftId, patch);
  }

  async archive(alias, messageIds) {
    const account = this.account(alias);
    return this.provider(account).archive(
      account,
      requireIds(messageIds, "message_ids", this.safety.maxWriteBatch),
    );
  }

  async markRead(alias, messageIds, isRead = true) {
    const account = this.account(alias);
    if (typeof isRead !== "boolean") {
      throw new MultiEmailError("is_read must be a boolean.", "INVALID_INPUT");
    }
    return this.provider(account).markRead(
      account,
      requireIds(messageIds, "message_ids", this.safety.maxWriteBatch),
      isRead,
    );
  }

  async listLabels(alias) {
    const account = this.account(alias);
    const provider = this.provider(account);
    if (!provider.listLabels) {
      throw new MultiEmailError(
        `Labels are not supported for provider '${account.provider}'.`,
        "UNSUPPORTED_OPERATION",
      );
    }
    return provider.listLabels(account);
  }

  async modifyLabels(alias, messageIds, { addLabelIds = [], removeLabelIds = [] }) {
    const account = this.account(alias);
    const provider = this.provider(account);
    if (!provider.modifyLabels) {
      throw new MultiEmailError(
        `Label changes are not supported for provider '${account.provider}'.`,
        "UNSUPPORTED_OPERATION",
      );
    }
    const normalizeLabels = (values, field) => {
      if (!Array.isArray(values)) {
        throw new MultiEmailError(`${field} must be an array.`, "INVALID_INPUT");
      }
      if (values.length > this.safety.maxLabelChanges) {
        throw new MultiEmailError(
          `${field} exceeds the hard label-change limit of ${this.safety.maxLabelChanges}.`,
          "SAFETY_LIMIT",
        );
      }
      const normalized = values.map((value) =>
        requireString(value, field, { maxLength: 256 }),
      );
      if (new Set(normalized).size !== normalized.length) {
        throw new MultiEmailError(`${field} contains duplicate label IDs.`, "INVALID_INPUT");
      }
      return normalized;
    };
    const add = normalizeLabels(addLabelIds, "add_label_ids");
    const remove = normalizeLabels(removeLabelIds, "remove_label_ids");
    if (add.length + remove.length > this.safety.maxLabelChanges) {
      throw new MultiEmailError(
        `Combined label changes exceed the hard limit of ${this.safety.maxLabelChanges}.`,
        "SAFETY_LIMIT",
      );
    }
    if (!add.length && !remove.length) {
      throw new MultiEmailError("At least one label change is required.", "INVALID_INPUT");
    }
    if (add.some((labelId) => remove.includes(labelId))) {
      throw new MultiEmailError(
        "A label ID cannot be added and removed in the same operation.",
        "INVALID_INPUT",
      );
    }
    return provider.modifyLabels(
      account,
      requireIds(messageIds, "message_ids", this.safety.maxWriteBatch),
      { addLabelIds: add, removeLabelIds: remove },
    );
  }

  async reviewDraft(alias, draftId) {
    const account = this.account(alias);
    const normalizedDraftId = requireString(draftId, "draft_id", { maxLength: 1024 });
    const review = await this.provider(account).reviewDraft(
      account,
      normalizedDraftId,
    );
    const canonical = canonicalDraftReview(
      account,
      normalizedDraftId,
      review,
      this.safety.maxRecipients,
    );
    const approval = this.approvals.prepare(canonical);
    const preview = safePreview(canonical.body);
    let approvalWindowOpened = false;
    if (this.approvalUi) {
      try {
        await this.approvalUi.requestApproval(approval.requestId);
      } catch (error) {
        this.approvals.discard(approval.requestId);
        throw error;
      }
      approvalWindowOpened = true;
    }
    return {
      account: canonical.account,
      provider: account.provider,
      draftId: canonical.draftId,
      messageId: canonical.messageId,
      to: canonical.to,
      cc: canonical.cc,
      bcc: canonical.bcc,
      subject: canonical.subject,
      bodyPreview: preview.text,
      bodyPreviewTruncated: preview.truncated,
      bodyBytes: Buffer.byteLength(canonical.body, "utf8"),
      approvalRequestId: approval.requestId,
      approvalExpiresAt: approval.expiresAt,
      approvalWindowOpened,
      approvalStatus: "pending_human_approval",
      requiredNextStep:
        "Review the complete draft in the local approval window and click Approve. No MCP tool can approve it. Only then call mail_send_draft with this approval request ID.",
    };
  }

  async sendDraft(alias, draftId, approvalRequestId) {
    const account = this.account(alias);
    const normalizedDraftId = requireString(draftId, "draft_id", { maxLength: 1024 });
    const requestId = requireString(approvalRequestId, "approval_request_id", { maxLength: 512 });
    const provider = this.provider(account);
    // Fail before any provider request if the human has not approved out of band.
    this.approvals.requireApproved(requestId, {
      account: account.alias,
      draftId: normalizedDraftId,
    });
    let canonical;
    try {
      const review = await provider.reviewDraft(account, normalizedDraftId);
      canonical = canonicalDraftReview(
        account,
        normalizedDraftId,
        review,
        this.safety.maxRecipients,
      );
    } catch (error) {
      // Any attempted use spends the human approval, including a provider review
      // failure or a draft that is no longer eligible for complete review.
      try {
        this.approvals.rejectOutOfBand(requestId);
      } catch {
        // Preserve the provider/review failure that caused this approval to be spent.
      }
      if (isKnownPreSendTransportFailure(error)) {
        throw new MultiEmailError(
          "The approved draft could not be rechecked before sending. Nothing was sent.",
          "SEND_VERIFICATION_FAILED",
          { account: account.alias, draftId: normalizedDraftId },
        );
      }
      throw error;
    }
    this.approvals.consumeApproved(requestId, canonical);
    try {
      return await provider.sendDraft(account, normalizedDraftId, canonical);
    } catch (error) {
      if (error?.code === "DRAFT_CHANGED" || error?.code === "SEND_VERIFICATION_FAILED") {
        throw error;
      }
      console.error(
        `[multi-email] send outcome unknown for ${account.alias}: ` +
          safePublicErrorCode(error?.code || error?.name),
      );
      throw new MultiEmailError(
        "The send request did not complete cleanly, so delivery status is unknown. Do not retry automatically; check Sent first.",
        "SEND_STATUS_UNKNOWN",
        { account: account.alias, draftId: normalizedDraftId },
      );
    }
  }
}
