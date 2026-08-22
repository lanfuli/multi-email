import { GmailProvider } from "./providers/gmail.mjs";
import { MicrosoftProvider } from "./providers/microsoft.mjs";
import { findAccount } from "./config.mjs";
import { MultiEmailError } from "./errors.mjs";
import { normalizeAddresses } from "./mime.mjs";
import { SendApprovalStore } from "./send-approval.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

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

function canonicalDraftReview(account, draftId, review, maxRecipients) {
  const recipients = validateRecipients(review, maxRecipients, { requireAny: true });
  return {
    account: account.alias,
    draftId,
    messageId: review.messageId,
    ...recipients,
    subject: validateSubject(review.subject || ""),
    body: validateBody(review.body || ""),
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
    this.credentialStore = credentialStore;
    this.approvals =
      approvalStore ||
      new SendApprovalStore({ ttlSeconds: config.safety.sendApprovalTtlSeconds });
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
        const provider = this.provider(account);
        if (typeof provider.diagnose !== "function") {
          throw new MultiEmailError(
            `Diagnostics are not supported for provider '${account.provider}'.`,
            "UNSUPPORTED_OPERATION",
          );
        }
        return provider.diagnose(account);
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
    const requested = maxResults ?? Math.min(10, this.config.safety.maxSearchResults);
    if (!Number.isInteger(requested) || requested < 1) {
      throw new MultiEmailError("max_results must be a positive integer.", "INVALID_INPUT");
    }
    if (requested > this.config.safety.maxSearchResults) {
      throw new MultiEmailError(
        `max_results exceeds the configured limit of ${this.config.safety.maxSearchResults}.`,
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
    const recipients = validateRecipients(input, this.config.safety.maxRecipients);
    return this.provider(account).createDraft(account, {
      ...recipients,
      subject: validateSubject(input.subject || ""),
      body: validateBody(input.body || ""),
    });
  }

  async createReplyDraft(alias, input) {
    const account = this.account(alias);
    const recipients = validateRecipients(input, this.config.safety.maxRecipients);
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
      this.config.safety.maxRecipients,
    );
    return provider.updateDraft(account, normalizedDraftId, patch);
  }

  async archive(alias, messageIds) {
    const account = this.account(alias);
    return this.provider(account).archive(
      account,
      requireIds(messageIds, "message_ids", this.config.safety.maxWriteBatch),
    );
  }

  async markRead(alias, messageIds, isRead = true) {
    const account = this.account(alias);
    if (typeof isRead !== "boolean") {
      throw new MultiEmailError("is_read must be a boolean.", "INVALID_INPUT");
    }
    return this.provider(account).markRead(
      account,
      requireIds(messageIds, "message_ids", this.config.safety.maxWriteBatch),
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
      return [...new Set(values.map((value) => requireString(value, field, { maxLength: 256 })))]
        .filter(Boolean);
    };
    const add = normalizeLabels(addLabelIds, "add_label_ids");
    const remove = normalizeLabels(removeLabelIds, "remove_label_ids");
    if (!add.length && !remove.length) {
      throw new MultiEmailError("At least one label change is required.", "INVALID_INPUT");
    }
    return provider.modifyLabels(
      account,
      requireIds(messageIds, "message_ids", this.config.safety.maxWriteBatch),
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
      this.config.safety.maxRecipients,
    );
    const approval = this.approvals.prepare(canonical);
    const preview = safePreview(canonical.body);
    let approvalWindowOpened = false;
    if (this.approvalUi) {
      await this.approvalUi.requestApproval(approval.requestId);
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
    const review = await provider.reviewDraft(account, normalizedDraftId);
    const canonical = canonicalDraftReview(
      account,
      normalizedDraftId,
      review,
      this.config.safety.maxRecipients,
    );
    this.approvals.consumeApproved(requestId, canonical);
    try {
      return await provider.sendDraft(account, normalizedDraftId);
    } catch (error) {
      console.error(
        `[multi-email] send outcome unknown for ${account.alias}/${normalizedDraftId}: ` +
          String(error?.code || error?.name || "provider_error"),
      );
      throw new MultiEmailError(
        "The send request did not complete cleanly, so delivery status is unknown. Do not retry automatically; check Sent first.",
        "SEND_STATUS_UNKNOWN",
        { account: account.alias, draftId: normalizedDraftId },
      );
    }
  }
}
