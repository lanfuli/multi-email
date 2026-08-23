import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { auth as googleAuth, gmail as createGmailClient } from "@googleapis/gmail";
import { decodeWords } from "postal-mime";
import { GOOGLE_SCOPES, HARD_SAFETY_LIMITS } from "../constants.mjs";
import { MultiEmailError } from "../errors.mjs";
import { credentialAccountKey, legacyCredentialAccountKey } from "../keychain.mjs";
import {
  buildRawMessage,
  extractGmailBody,
  headersToObject,
  splitAddressHeader,
} from "../mime.mjs";
import {
  EFFECTIVE_SEND_MANIFEST_VERSION,
  EFFECTIVE_SEND_POLICY_VERSION,
} from "../send-approval.mjs";

const PROFILE_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
];
const REQUIRED_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const MAX_REVIEW_BODY_BYTES = 1024 * 1024;
const MAX_REVIEW_RAW_BYTES = 2 * 1024 * 1024;
const MAX_SUBJECT_BYTES = 998;
const MAX_IN_REPLY_TO_BYTES = 900;
const MAX_REFERENCES_BYTES = 8192;
const UNSUPPORTED_MATERIAL_HEADERS = new Set([
  "apparently-to",
  "bounces-to",
  "disposition-notification-to",
  "envelope-to",
  "errors-to",
  "mail-followup-to",
  "mail-reply-to",
  "return-path",
  "return-receipt-to",
  "x-confirm-reading-to",
]);

function draftNotReviewable(message) {
  return new MultiEmailError(message, "DRAFT_NOT_REVIEWABLE");
}

function headerValues(headers, name) {
  if (headers !== undefined && !Array.isArray(headers)) {
    throw draftNotReviewable("The Gmail draft headers are incomplete or invalid.");
  }
  const normalizedName = String(name).toLowerCase();
  return (headers || [])
    .filter((header) => String(header?.name || "").toLowerCase() === normalizedName)
    .map((header) => String(header?.value ?? ""));
}

function uniqueHeader(headers, name, { required = false } = {}) {
  const values = headerValues(headers, name);
  if (values.length > 1 || (required && values.length !== 1)) {
    throw draftNotReviewable(
      `The Gmail draft must contain ${required ? "exactly one" : "at most one"} ${name} header.`,
    );
  }
  return values[0];
}

function assertNoUnsupportedMaterialHeaders(headers) {
  if (!Array.isArray(headers)) {
    throw draftNotReviewable("The Gmail draft headers are incomplete or invalid.");
  }
  for (const header of headers) {
    const name = String(header?.name || "").trim().toLowerCase();
    if (name.startsWith("resent-") || UNSUPPORTED_MATERIAL_HEADERS.has(name)) {
      throw draftNotReviewable(
        "The Gmail draft contains an unsupported material sending header.",
      );
    }
  }
}

function singleBareAddress(value, headerName) {
  const text = String(value ?? "").trim();
  if (/\r|\n/u.test(text)) {
    throw draftNotReviewable(
      `The Gmail draft ${headerName} header must contain exactly one email address.`,
    );
  }
  const angleAddress = text.match(/^[^<>]*<([^<>]+)>$/u);
  const candidate = (angleAddress?.[1] || text).trim();
  let addresses;
  try {
    addresses = splitAddressHeader(candidate);
  } catch {
    throw draftNotReviewable(
      `The Gmail draft ${headerName} header must contain exactly one email address.`,
    );
  }
  if (
    addresses.length !== 1 ||
    candidate.toLowerCase() !== addresses[0] ||
    (!angleAddress && /[<>,;]/u.test(text))
  ) {
    throw draftNotReviewable(
      `The Gmail draft ${headerName} header must contain exactly one email address.`,
    );
  }
  return addresses[0];
}

function addressHeaderList(value, headerName) {
  if (value === undefined || value === "") return [];
  try {
    return splitAddressHeader(value);
  } catch {
    throw draftNotReviewable(`The Gmail draft ${headerName} header is invalid.`);
  }
}

function singleAddressHeader(value, headerName) {
  const addresses = addressHeaderList(value, headerName);
  if (addresses.length !== 1) {
    throw draftNotReviewable(
      `The Gmail draft ${headerName} header must contain exactly one email address.`,
    );
  }
  return addresses[0];
}

function decodeBase64UrlBytes(
  value,
  description,
  { allowEmpty = true, maxBytes = MAX_REVIEW_RAW_BYTES } = {},
) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !/^[A-Za-z0-9_-]*={0,2}$/u.test(value) ||
    value.length % 4 === 1
  ) {
    throw draftNotReviewable(`The Gmail draft ${description} is missing or invalid.`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length > maxBytes ||
    bytes.toString("base64url") !== value.replace(/=+$/u, "")
  ) {
    throw draftNotReviewable(`The Gmail draft ${description} is not valid base64url data.`);
  }
  return bytes;
}

function reviewPlainTextPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw draftNotReviewable("The Gmail draft has no complete MIME payload.");
  }

  const parts = payload.parts;
  if ((parts != null && !Array.isArray(parts)) || (Array.isArray(parts) && parts.length)) {
    throw draftNotReviewable(
      "Multipart or nested Gmail drafts cannot be reviewed completely and will not be sent.",
    );
  }
  if (String(payload.mimeType || "").trim().toLowerCase() !== "text/plain") {
    throw draftNotReviewable(
      "Only a single complete text/plain Gmail draft can be reviewed and sent.",
    );
  }
  const contentType = uniqueHeader(payload.headers, "Content-Type");
  if (contentType && contentType.split(";", 1)[0].trim().toLowerCase() !== "text/plain") {
    throw draftNotReviewable("The Gmail draft has contradictory MIME content metadata.");
  }
  if (String(payload.filename || "").trim() || payload.body?.attachmentId) {
    throw draftNotReviewable("Gmail drafts with attachments cannot be reviewed and sent.");
  }

  const contentDisposition = headerValues(payload.headers, "Content-Disposition");
  const contentId = headerValues(payload.headers, "Content-ID");
  if (contentDisposition.length || contentId.length) {
    throw draftNotReviewable("Inline or attached Gmail MIME content cannot be reviewed and sent.");
  }

  const encodedBody = payload.body?.data;
  const declaredSize = payload.body?.size;
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw draftNotReviewable("The Gmail draft body size is missing or invalid.");
  }
  if (encodedBody === undefined && declaredSize !== 0) {
    throw draftNotReviewable("The Gmail draft body is incomplete and cannot be reviewed.");
  }
  const bodyBytes = decodeBase64UrlBytes(encodedBody ?? "", "body", {
    maxBytes: MAX_REVIEW_BODY_BYTES,
  });
  if (bodyBytes.length !== declaredSize) {
    throw draftNotReviewable("The Gmail draft body is incomplete and cannot be reviewed.");
  }
  if (bodyBytes.length > MAX_REVIEW_BODY_BYTES) {
    throw draftNotReviewable("The Gmail draft body exceeds the 1 MB review limit.");
  }

  const body = bodyBytes.toString("utf8");
  if (!Buffer.from(body, "utf8").equals(bodyBytes)) {
    throw draftNotReviewable("The Gmail draft body is not valid UTF-8 text.");
  }
  return body;
}

function rawDraftRevision(response, draftId) {
  const draft = response?.data;
  const message = draft?.message;
  if (
    String(draft?.id || "") !== draftId ||
    !message?.id ||
    !message?.threadId ||
    typeof message.raw !== "string"
  ) {
    throw draftNotReviewable("The Gmail raw draft identity or payload is incomplete.");
  }
  const rawBytes = decodeBase64UrlBytes(message.raw, "raw payload", {
    allowEmpty: false,
    maxBytes: MAX_REVIEW_RAW_BYTES,
  });
  return {
    draftId: draft.id,
    messageId: String(message.id),
    threadId: String(message.threadId),
    rawPayloadSha256: createHash("sha256").update(rawBytes).digest("hex"),
  };
}

function assertSameDraftSnapshot(fullDraft, rawRevision, requestedDraftId) {
  const message = fullDraft?.message;
  if (
    String(fullDraft?.id || "") !== requestedDraftId ||
    !message?.id ||
    !message?.threadId ||
    String(message.id) !== rawRevision.messageId ||
    String(message.threadId) !== rawRevision.threadId
  ) {
    throw draftNotReviewable(
      "The Gmail full and raw draft snapshots do not identify the same message and thread.",
    );
  }
  return message;
}

function assertSameRawRevision(before, after) {
  if (
    before.draftId !== after.draftId ||
    before.messageId !== after.messageId ||
    before.threadId !== after.threadId ||
    before.rawPayloadSha256 !== after.rawPayloadSha256
  ) {
    throw draftNotReviewable(
      "The Gmail draft changed while its complete raw revision was being reviewed.",
    );
  }
}

function reviewedSubject(headers) {
  const encoded = uniqueHeader(headers, "Subject") ?? "";
  if (/\r|\n/u.test(encoded) || Buffer.byteLength(encoded, "utf8") > MAX_SUBJECT_BYTES) {
    throw draftNotReviewable("The Gmail draft Subject header is invalid or too long.");
  }
  let decoded;
  try {
    decoded = decodeWords(encoded);
  } catch {
    throw draftNotReviewable("The Gmail draft Subject header could not be decoded safely.");
  }
  if (
    typeof decoded !== "string" ||
    /\r|\n/u.test(decoded) ||
    Buffer.byteLength(decoded, "utf8") > MAX_SUBJECT_BYTES
  ) {
    throw draftNotReviewable("The decoded Gmail draft Subject is invalid or too long.");
  }
  return decoded;
}

function reviewedThreadHeader(headers, name, maxBytes) {
  const value = uniqueHeader(headers, name);
  if (value === undefined) return "";
  if (/\r|\n/u.test(value)) {
    throw draftNotReviewable(`The Gmail draft ${name} header contains a line break.`);
  }
  const normalized = String(value).trim().replace(/[\t ]+/gu, " ");
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw draftNotReviewable(`The Gmail draft ${name} header is empty or too long.`);
  }
  if (
    name === "References" &&
    normalized.split(" ").some((token) => Buffer.byteLength(token, "utf8") > 900)
  ) {
    throw draftNotReviewable("The Gmail draft References header contains an oversized message ID.");
  }
  return normalized;
}

function draftChanged(
  message = "The Gmail draft changed after review. Prepare and review it again before sending.",
) {
  return new MultiEmailError(message, "DRAFT_CHANGED");
}

function requireManifestString(
  manifest,
  field,
  { allowEmpty = false, allowLineBreaks = false, maxBytes = 4096 } = {},
) {
  const value = manifest?.[field];
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    (!allowLineBreaks && /\r|\n/u.test(value)) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw draftChanged("The approved Gmail send manifest is missing or malformed.");
  }
  return value;
}

function requireCanonicalAddresses(manifest, field) {
  const values = manifest?.[field];
  if (!Array.isArray(values)) {
    throw draftChanged("The approved Gmail send manifest is missing or malformed.");
  }
  return Array.from({ length: values.length }, (_, index) => {
    if (!Object.hasOwn(values, index)) {
      throw draftChanged("The approved Gmail send manifest contains a sparse address list.");
    }
    const value = values[index];
    const address = requireManifestString({ value }, "value", { maxBytes: 320 });
    let normalized;
    try {
      normalized = singleBareAddress(address, field);
    } catch {
      throw draftChanged("The approved Gmail send manifest contains an invalid address.");
    }
    if (address !== normalized) {
      throw draftChanged("The approved Gmail send manifest contains a non-canonical address.");
    }
    return normalized;
  });
}

function validatedApprovedManifest(account, draftId, manifest) {
  const invalid = () => {
    throw draftChanged("A complete approved Gmail send manifest is required before sending.");
  };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) invalid();

  const expectedEmail = String(account?.email || "").trim().toLowerCase();
  if (
    manifest.manifestVersion !== EFFECTIVE_SEND_MANIFEST_VERSION ||
    manifest.policyVersion !== EFFECTIVE_SEND_POLICY_VERSION ||
    manifest.account !== account?.alias ||
    manifest.provider !== "google" ||
    manifest.authenticatedPrincipal !== expectedEmail ||
    manifest.mailboxResource !== expectedEmail ||
    manifest.draftId !== draftId ||
    manifest.bodyFormat !== "text" ||
    manifest.completeness !== "complete" ||
    !Array.isArray(manifest.attachments) ||
    manifest.attachments.length !== 0 ||
    !Array.isArray(manifest.replyTo) ||
    manifest.replyTo.length !== 0
  ) {
    invalid();
  }

  const messageId = requireManifestString(manifest, "messageId", { maxBytes: 1024 });
  const threadId = requireManifestString(manifest, "threadId", { maxBytes: 1024 });
  const from = requireManifestString(manifest, "from", { maxBytes: 320 });
  const sender = requireManifestString(manifest, "sender", { maxBytes: 320 });
  if (from !== expectedEmail || sender !== expectedEmail) invalid();

  const to = requireCanonicalAddresses(manifest, "to");
  const cc = requireCanonicalAddresses(manifest, "cc");
  const bcc = requireCanonicalAddresses(manifest, "bcc");
  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount === 0 || recipientCount > HARD_SAFETY_LIMITS.maxRecipients) invalid();

  const subject = requireManifestString(manifest, "subject", {
    allowEmpty: true,
    maxBytes: MAX_SUBJECT_BYTES,
  });
  const body = requireManifestString(manifest, "body", {
    allowEmpty: true,
    allowLineBreaks: true,
    maxBytes: MAX_REVIEW_BODY_BYTES,
  });
  const bodySha256 = requireManifestString(manifest, "bodySha256", { maxBytes: 64 });
  if (
    !/^[a-f0-9]{64}$/u.test(bodySha256) ||
    bodySha256 !== createHash("sha256").update(body, "utf8").digest("hex")
  ) {
    invalid();
  }

  const inReplyTo = requireManifestString(manifest, "inReplyTo", {
    allowEmpty: true,
    maxBytes: MAX_IN_REPLY_TO_BYTES,
  });
  const references = requireManifestString(manifest, "references", {
    allowEmpty: true,
    maxBytes: MAX_REFERENCES_BYTES,
  });
  const referenceTokens = references ? references.split(/[\t ]+/u) : [];
  if (
    inReplyTo !== inReplyTo.trim().replace(/[\t ]+/gu, " ") ||
    references !== references.trim().replace(/[\t ]+/gu, " ") ||
    (inReplyTo && !/^<[^<>\s]{1,900}>$/u.test(inReplyTo)) ||
    referenceTokens.some(
      (token) =>
        Buffer.byteLength(token, "utf8") > 900 || !/^<[^<>\s]{1,900}>$/u.test(token),
    )
  ) {
    invalid();
  }

  const revision = manifest.providerRevision;
  if (
    !revision ||
    typeof revision !== "object" ||
    Array.isArray(revision) ||
    revision.messageId !== messageId ||
    revision.threadId !== threadId ||
    typeof revision.rawPayloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(revision.rawPayloadSha256) ||
    revision.changeKey !== null ||
    revision.lastModifiedDateTime !== null
  ) {
    invalid();
  }

  return {
    messageId,
    threadId,
    from,
    to,
    cc,
    bcc,
    subject,
    body,
    inReplyTo,
    references,
    providerRevision: revision,
  };
}

function credentialKey(config, account) {
  return credentialAccountKey(config, account);
}

function legacyCredentialKey(account) {
  return legacyCredentialAccountKey(account);
}

function normalizedScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || "").split(/\s+/);
  return new Set(values.map((scope) => String(scope).trim().toLowerCase()).filter(Boolean));
}

function hasRequiredScopes(scopes) {
  return normalizedScopes(scopes).has(REQUIRED_GMAIL_SCOPE);
}

function assertProfileMatches(account, profile) {
  const actualEmail = String(profile?.data?.emailAddress || profile?.emailAddress || "")
    .trim()
    .toLowerCase();
  if (actualEmail !== account.email) {
    throw new MultiEmailError(
      `Authenticated '${actualEmail || "unknown"}', but '${account.email}' was expected. Refusing to use this mailbox.`,
      "ACCOUNT_MISMATCH",
    );
  }
  return actualEmail;
}

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(res, statusCode, message) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    connection: "close",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Multi Email OAuth</title>` +
      `<body style="font:16px system-ui;padding:40px;max-width:640px">` +
      `<h1>${statusCode === 200 ? "Authorization complete" : "Authorization failed"}</h1>` +
      `<p>${escapeHtml(message)}</p><p>You may close this window.</p></body>`,
  );
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

export async function closeHttpServer(server) {
  if (!server.listening) {
    server.closeAllConnections?.();
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

function parseToken(raw, alias) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new MultiEmailError(
      `The Google credential for '${alias}' is corrupt. Reauthorize this account.`,
      "INVALID_CREDENTIAL",
    );
  }
}

function compactBody(body, limit = 80_000) {
  if (body.length <= limit) return { body, truncated: false };
  return { body: `${body.slice(0, limit)}\n\n[truncated]`, truncated: true };
}

export class GmailProvider {
  constructor({ config, credentialStore, browserOpener = openBrowser }) {
    this.config = config;
    this.credentialStore = credentialStore;
    this.browserOpener = browserOpener;
    this.verifiedAliases = new Set();
  }

  providerConfig() {
    const provider = this.config.providers.google || {};
    if (!provider.clientId || !provider.clientSecret) {
      throw new MultiEmailError(
        "Google OAuth client is not configured. Run 'multi-email init --google-client-json <desktop-oauth.json>' (or the same node ./scripts/multi-email command from a Git clone).",
        "GOOGLE_CLIENT_NOT_CONFIGURED",
      );
    }
    return provider;
  }

  async isAuthenticated(account) {
    return (await this.credentialRecord(account)) !== null;
  }

  async credentialRecord(account, { allowLegacy = true } = {}) {
    const key = credentialKey(this.config, account);
    const current = await this.credentialStore.get(key);
    if (current !== null) return { key, raw: current, source: "profile" };

    if (!allowLegacy || typeof this.credentialStore.getLegacy !== "function") return null;
    const legacyKey = legacyCredentialKey(account);
    const legacy = await this.credentialStore.getLegacy(legacyKey);
    return legacy === null ? null : { key, legacyKey, raw: legacy, source: "legacy" };
  }

  async authorize(account, { onInstruction = console.log, timeoutMs = 5 * 60_000 } = {}) {
    const provider = this.providerConfig();
    const state = randomBytes(32).toString("base64url");
    let settle;
    const callback = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });

    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url, "http://127.0.0.1");
        if (requestUrl.pathname !== "/oauth/google/callback") {
          htmlResponse(res, 404, "Unknown callback path.");
          return;
        }
        if (requestUrl.searchParams.get("state") !== state) {
          htmlResponse(res, 400, "OAuth state did not match.");
          settle.reject(new MultiEmailError("Google OAuth state mismatch.", "OAUTH_STATE_MISMATCH"));
          return;
        }
        const oauthError = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");
        if (oauthError || !code) {
          const safeOauthError = /^[a-z0-9_.-]{1,80}$/i.test(oauthError || "")
            ? oauthError
            : undefined;
          htmlResponse(res, 400, "Google did not return an authorization code.");
          settle.reject(
            new MultiEmailError(
              `Google OAuth was not completed${safeOauthError ? `: ${safeOauthError}` : "."}`,
              "OAUTH_DENIED",
            ),
          );
          return;
        }
        htmlResponse(
          res,
          200,
          "Authorization code received. Return to the terminal while identity and scope checks finish.",
        );
        settle.resolve(code);
      } catch (error) {
        settle.reject(error);
      }
    });

    let timer;
    try {
      const port = await listen(server);
      const redirectUri = `http://127.0.0.1:${port}/oauth/google/callback`;
      const oauth = new googleAuth.OAuth2(provider.clientId, provider.clientSecret, redirectUri);
      const authorizationUrl = oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: true,
        scope: GOOGLE_SCOPES,
        state,
        login_hint: account.email,
      });

      onInstruction(`Opening Google authorization for ${account.alias} (${account.email})...`);
      try {
        await this.browserOpener(authorizationUrl);
      } catch {
        throw new MultiEmailError(
          "Unable to open the Google authorization page. No OAuth URL was printed; check browser permissions and try again.",
          "BROWSER_OPEN_FAILED",
        );
      }

      const code = await Promise.race([
        callback,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new MultiEmailError("Google OAuth timed out.", "OAUTH_TIMEOUT")),
            timeoutMs,
          );
        }),
      ]);
      const { tokens } = await oauth.getToken(code);
      if (!tokens.refresh_token) {
        throw new MultiEmailError(
          "Google did not return a refresh token. Revoke the app grant and authorize again.",
          "MISSING_REFRESH_TOKEN",
        );
      }
      oauth.setCredentials(tokens);
      const gmail = createGmailClient({ version: "v1", auth: oauth });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const actualEmail = assertProfileMatches(account, profile);
      if (tokens.scope && !hasRequiredScopes(tokens.scope)) {
        throw new MultiEmailError(
          "Google did not grant the required Gmail modify scope. Nothing was saved.",
          "INSUFFICIENT_SCOPES",
        );
      }
      await this.credentialStore.set(credentialKey(this.config, account), JSON.stringify(tokens));
      this.verifiedAliases.add(account.alias);
      return { alias: account.alias, email: actualEmail, provider: "google" };
    } finally {
      clearTimeout(timer);
      await closeHttpServer(server);
    }
  }

  async oauthSession(account, { persistUpdates = true, allowLegacy = true } = {}) {
    const provider = this.providerConfig();
    const record = await this.credentialRecord(account, { allowLegacy });
    if (!record) {
      throw new MultiEmailError(
        `Account '${account.alias}' is not authorized. Run 'multi-email auth ${account.alias}' (or 'node ./scripts/multi-email auth ${account.alias}' from a Git clone).`,
        "NOT_AUTHENTICATED",
      );
    }
    let tokens = parseToken(record.raw, account.alias);
    const oauth = new googleAuth.OAuth2(provider.clientId, provider.clientSecret);
    oauth.setCredentials(tokens);
    oauth.on("tokens", (updates) => {
      tokens = { ...tokens, ...updates };
      if (persistUpdates && record.source === "profile") {
        void this.credentialStore.set(record.key, JSON.stringify(tokens)).catch(() => {
          // Credential values and provider errors must never escape via an
          // unhandled rejection. A later request will surface reauthorization.
        });
      }
    });
    return {
      oauth,
      record,
      currentTokens: () => tokens,
    };
  }

  async oauthClient(account) {
    return (await this.oauthSession(account)).oauth;
  }

  async client(account) {
    const session = await this.oauthSession(account);
    const gmail = createGmailClient({ version: "v1", auth: session.oauth });
    if (!this.verifiedAliases.has(account.alias) || session.record.source === "legacy") {
      const response = await gmail.users.getProfile({ userId: "me" });
      assertProfileMatches(account, response);
      if (session.record.source === "legacy") {
        // Copy, but do not delete, the old entry. The old namespace is shared by
        // historical installs, so deletion is reserved for an explicit logout.
        await this.credentialStore.set(
          session.record.key,
          JSON.stringify(session.currentTokens()),
        );
      }
      this.verifiedAliases.add(account.alias);
    }
    return gmail;
  }

  async profile(account) {
    const gmail = await this.client(account);
    const response = await gmail.users.getProfile({ userId: "me" });
    const email = assertProfileMatches(account, response);
    return {
      email,
      messagesTotal: response.data.messagesTotal,
      threadsTotal: response.data.threadsTotal,
    };
  }

  async diagnose(account) {
    const diagnostic = {
      alias: account.alias,
      provider: "google",
      expected_email: account.email,
      credential_present: false,
      token_valid: null,
      identity_verified: null,
      scopes_valid: null,
      credential_source: null,
      legacy_migration_pending: false,
      status: "not_authorized",
      error_code: null,
    };

    try {
      this.providerConfig();
      const record = await this.credentialRecord(account);
      if (!record) return diagnostic;
      diagnostic.credential_present = true;
      diagnostic.credential_source = record.source;
      diagnostic.legacy_migration_pending = record.source === "legacy";

      let session;
      try {
        session = await this.oauthSession(account, { persistUpdates: false });
      } catch (error) {
        diagnostic.token_valid = false;
        diagnostic.status = "invalid_credential";
        diagnostic.error_code = error?.code || "INVALID_CREDENTIAL";
        return diagnostic;
      }

      let accessToken;
      let tokenInfo;
      try {
        const access = await session.oauth.getAccessToken();
        accessToken = typeof access === "string" ? access : access?.token;
        if (!accessToken) throw new Error("missing access token");
        tokenInfo = await session.oauth.getTokenInfo(accessToken);
        diagnostic.token_valid = true;
      } catch {
        diagnostic.token_valid = false;
        diagnostic.status = "reauthorization_required";
        diagnostic.error_code = "REAUTHENTICATION_REQUIRED";
        return diagnostic;
      }

      diagnostic.scopes_valid = hasRequiredScopes(tokenInfo?.scopes);
      if (!diagnostic.scopes_valid) {
        diagnostic.status = "insufficient_scopes";
        diagnostic.error_code = "INSUFFICIENT_SCOPES";
        return diagnostic;
      }

      try {
        const gmail = createGmailClient({ version: "v1", auth: session.oauth });
        const profile = await gmail.users.getProfile({ userId: "me" });
        assertProfileMatches(account, profile);
        diagnostic.identity_verified = true;
        diagnostic.status = "ok";
      } catch (error) {
        diagnostic.identity_verified = error?.code === "ACCOUNT_MISMATCH" ? false : null;
        diagnostic.status =
          diagnostic.identity_verified === false ? "identity_mismatch" : "provider_unavailable";
        diagnostic.error_code = error?.code || "GOOGLE_PROFILE_FAILED";
      }
      return diagnostic;
    } catch (error) {
      diagnostic.status = "configuration_error";
      diagnostic.error_code = error?.code || "GOOGLE_CLIENT_NOT_CONFIGURED";
      return diagnostic;
    }
  }

  async logout(account) {
    const key = credentialKey(this.config, account);
    const removed = await this.credentialStore.delete(key);
    let legacyRemoved = false;
    let legacyPreserved = false;

    if (typeof this.credentialStore.getLegacy === "function") {
      const legacyKey = legacyCredentialKey(account);
      const legacy = await this.credentialStore.getLegacy(legacyKey);
      if (legacy !== null) {
        try {
          const provider = this.providerConfig();
          const tokens = parseToken(legacy, account.alias);
          const oauth = new googleAuth.OAuth2(provider.clientId, provider.clientSecret);
          oauth.setCredentials(tokens);
          const gmail = createGmailClient({ version: "v1", auth: oauth });
          assertProfileMatches(account, await gmail.users.getProfile({ userId: "me" }));
          legacyRemoved = await this.credentialStore.deleteLegacy(legacyKey);
        } catch {
          // Never delete a shared legacy entry unless its provider identity was proven.
          legacyPreserved = true;
        }
      }
    }

    this.verifiedAliases.delete(account.alias);
    return {
      alias: account.alias,
      provider: "google",
      local_credential_removed: Boolean(removed),
      verified_legacy_credential_removed: Boolean(legacyRemoved),
      unverified_legacy_credential_preserved: legacyPreserved,
    };
  }

  async revoke(account) {
    const session = await this.oauthSession(account, { persistUpdates: false });
    const gmail = createGmailClient({ version: "v1", auth: session.oauth });
    assertProfileMatches(account, await gmail.users.getProfile({ userId: "me" }));
    let verifiedLegacyKey = session.record.source === "legacy" ? session.record.legacyKey : null;
    if (!verifiedLegacyKey && typeof this.credentialStore.getLegacy === "function") {
      const candidateKey = legacyCredentialKey(account);
      const raw = await this.credentialStore.getLegacy(candidateKey);
      if (raw !== null) {
        try {
          const provider = this.providerConfig();
          const legacyOauth = new googleAuth.OAuth2(provider.clientId, provider.clientSecret);
          legacyOauth.setCredentials(parseToken(raw, account.alias));
          const legacyGmail = createGmailClient({ version: "v1", auth: legacyOauth });
          assertProfileMatches(account, await legacyGmail.users.getProfile({ userId: "me" }));
          verifiedLegacyKey = candidateKey;
        } catch {
          // A shared legacy entry is left untouched unless independently verified.
        }
      }
    }
    const tokens = session.currentTokens();
    const token = tokens.refresh_token || tokens.access_token;
    if (!token) {
      throw new MultiEmailError(
        "The Google credential has no revocable token. Use logout or reauthorize it.",
        "INVALID_CREDENTIAL",
      );
    }
    await session.oauth.revokeToken(token);
    const removed = await this.credentialStore.delete(credentialKey(this.config, account));
    let legacyRemoved = false;
    if (
      verifiedLegacyKey &&
      typeof this.credentialStore.deleteLegacy === "function"
    ) {
      legacyRemoved = await this.credentialStore.deleteLegacy(verifiedLegacyKey);
    }
    this.verifiedAliases.delete(account.alias);
    return {
      alias: account.alias,
      provider: "google",
      local_credential_removed: Boolean(removed),
      verified_legacy_credential_removed: Boolean(legacyRemoved),
      unverified_legacy_credential_preserved:
        typeof this.credentialStore.getLegacy === "function" &&
        (await this.credentialStore.getLegacy(legacyCredentialKey(account))) !== null,
      provider_grant_revoked: true,
    };
  }

  async search(account, { query, maxResults, pageToken }) {
    const gmail = await this.client(account);
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
      pageToken: pageToken || undefined,
    });
    const summaries = await Promise.all(
      (list.data.messages || []).map(async ({ id }) => {
        const response = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: PROFILE_HEADERS,
        });
        const headers = headersToObject(response.data.payload?.headers);
        return {
          id: response.data.id,
          threadId: response.data.threadId,
          from: headers.from || "",
          to: headers.to || "",
          subject: headers.subject || "",
          date: headers.date || "",
          snippet: response.data.snippet || "",
          labels: response.data.labelIds || [],
        };
      }),
    );
    return {
      account: account.alias,
      messages: summaries,
      nextPageToken: list.data.nextPageToken || null,
      resultSizeEstimate: list.data.resultSizeEstimate || 0,
    };
  }

  async getMessage(account, messageId) {
    const gmail = await this.client(account);
    const response = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const headers = headersToObject(response.data.payload?.headers);
    const extracted = extractGmailBody(response.data.payload);
    const preferredBody = extracted.body || extracted.htmlBody;
    const compact = compactBody(preferredBody);
    return {
      account: account.alias,
      id: response.data.id,
      threadId: response.data.threadId,
      from: headers.from || "",
      to: headers.to || "",
      cc: headers.cc || "",
      subject: headers.subject || "",
      date: headers.date || "",
      labels: response.data.labelIds || [],
      body: compact.body,
      bodyFormat: extracted.body ? "text" : "html",
      truncated: compact.truncated,
      attachmentNames: (response.data.payload?.parts || [])
        .filter((part) => part.filename)
        .map((part) => part.filename),
    };
  }

  async createDraft(account, input) {
    const gmail = await this.client(account);
    let threadId;
    let inReplyTo;
    let references;
    let subject = input.subject || "";
    let to = input.to || [];

    if (input.replyToMessageId) {
      const original = await gmail.users.messages.get({
        userId: "me",
        id: input.replyToMessageId,
        format: "metadata",
        metadataHeaders: PROFILE_HEADERS,
      });
      const headers = headersToObject(original.data.payload?.headers);
      threadId = original.data.threadId;
      inReplyTo = headers["message-id"] || undefined;
      references = [headers.references, headers["message-id"]].filter(Boolean).join(" ");
      if (!subject) {
        const originalSubject = headers.subject || "";
        subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
      }
      if (!to.length) to = splitAddressHeader(headers.from);
    }

    const raw = buildRawMessage({
      from: account.email,
      to,
      cc: input.cc || [],
      bcc: input.bcc || [],
      subject,
      body: input.body,
      inReplyTo,
      references,
    });
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, threadId } },
    });
    return {
      account: account.alias,
      provider: "google",
      draftId: response.data.id,
      messageId: response.data.message?.id,
      threadId: response.data.message?.threadId,
      subject,
      to,
      status: "draft_created",
    };
  }

  async createReplyDraft(account, { messageId, body, cc = [], bcc = [] }) {
    return this.createDraft(account, {
      replyToMessageId: messageId,
      body,
      cc,
      bcc,
    });
  }

  async updateDraft(account, draftId, input) {
    const gmail = await this.client(account);
    const current = await gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "full",
    });
    const message = current.data.message || {};
    const headers = headersToObject(message.payload?.headers);
    const extracted = extractGmailBody(message.payload);
    const raw = buildRawMessage({
      from: account.email,
      to: input.to ?? splitAddressHeader(headers.to),
      cc: input.cc ?? splitAddressHeader(headers.cc),
      bcc: input.bcc ?? splitAddressHeader(headers.bcc),
      subject: input.subject ?? headers.subject ?? "",
      body: input.body ?? extracted.body ?? extracted.htmlBody ?? "",
      inReplyTo: headers["in-reply-to"] || undefined,
      references: headers.references || undefined,
    });
    const response = await gmail.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: {
        id: draftId,
        message: { raw, threadId: message.threadId },
      },
    });
    return {
      account: account.alias,
      provider: "google",
      draftId: response.data.id,
      messageId: response.data.message?.id,
      threadId: response.data.message?.threadId,
      status: "draft_updated",
    };
  }

  async reviewDraft(account, draftId) {
    const gmail = await this.client(account);
    const rawBeforeResponse = await gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "raw",
    });
    const fullResponse = await gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "full",
    });
    const rawAfterResponse = await gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "raw",
    });
    const revisionBefore = rawDraftRevision(rawBeforeResponse, draftId);
    const revisionAfter = rawDraftRevision(rawAfterResponse, draftId);
    assertSameRawRevision(revisionBefore, revisionAfter);
    const message = assertSameDraftSnapshot(fullResponse.data, revisionAfter, draftId);
    const payloadHeaders = message.payload?.headers;
    assertNoUnsupportedMaterialHeaders(payloadHeaders);
    const from = singleAddressHeader(
      uniqueHeader(payloadHeaders, "From", { required: true }),
      "From",
    );
    const expectedFrom = String(account.email || "").trim().toLowerCase();
    if (from !== expectedFrom) {
      throw draftNotReviewable(
        "The Gmail draft From identity does not match the configured primary account.",
      );
    }

    const senderHeader = uniqueHeader(payloadHeaders, "Sender");
    const sender = senderHeader === undefined
      ? expectedFrom
      : singleAddressHeader(senderHeader, "Sender");
    if (sender !== expectedFrom) {
      throw draftNotReviewable(
        "The Gmail draft Sender identity does not match the configured primary account.",
      );
    }
    if (headerValues(payloadHeaders, "Reply-To").length) {
      throw draftNotReviewable(
        "Gmail drafts with a Reply-To identity cannot be reviewed and sent.",
      );
    }

    const to = uniqueHeader(payloadHeaders, "To");
    const cc = uniqueHeader(payloadHeaders, "Cc");
    const bcc = uniqueHeader(payloadHeaders, "Bcc");
    const subject = reviewedSubject(payloadHeaders);
    const inReplyTo = reviewedThreadHeader(
      payloadHeaders,
      "In-Reply-To",
      MAX_IN_REPLY_TO_BYTES,
    );
    const references = reviewedThreadHeader(
      payloadHeaders,
      "References",
      MAX_REFERENCES_BYTES,
    );
    const body = reviewPlainTextPayload(message.payload);
    return {
      account: account.alias,
      draftId,
      messageId: message.id,
      threadId: message.threadId,
      from,
      sender,
      replyTo: [],
      to: addressHeaderList(to, "To"),
      cc: addressHeaderList(cc, "Cc"),
      bcc: addressHeaderList(bcc, "Bcc"),
      subject,
      body,
      inReplyTo,
      references,
      bodyFormat: "text",
      attachments: [],
      completeness: "complete",
      truncated: false,
      rawPayloadSha256: revisionAfter.rawPayloadSha256,
    };
  }

  async sendDraft(account, draftId, approvedManifest) {
    const approved = validatedApprovedManifest(account, draftId, approvedManifest);
    let raw;
    try {
      raw = buildRawMessage({
        from: approved.from,
        to: approved.to,
        cc: approved.cc,
        bcc: approved.bcc,
        subject: approved.subject,
        body: approved.body,
        inReplyTo: approved.inReplyTo || undefined,
        references: approved.references || undefined,
      });
    } catch {
      throw draftChanged("The approved Gmail send manifest could not be reconstructed safely.");
    }

    const gmail = await this.client(account);
    let currentRevision;
    try {
      const rawResponse = await gmail.users.drafts.get({
        userId: "me",
        id: draftId,
        format: "raw",
      });
      currentRevision = rawDraftRevision(rawResponse, draftId);
    } catch {
      throw draftChanged(
        "The Gmail draft could not be verified against the reviewed revision. Prepare and review it again before sending.",
      );
    }
    if (
      currentRevision.messageId !== approved.providerRevision.messageId ||
      currentRevision.threadId !== approved.providerRevision.threadId ||
      currentRevision.rawPayloadSha256 !== approved.providerRevision.rawPayloadSha256
    ) {
      throw draftChanged(
        "The Gmail draft changed after review. Prepare and review it again before sending.",
      );
    }
    const message = { raw };
    if (approved.threadId) message.threadId = approved.threadId;
    const response = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId, message },
    });
    return {
      account: account.alias,
      provider: "google",
      sentMessageId: response.data.id,
      threadId: response.data.threadId,
      status: "sent",
    };
  }

  async archive(account, messageIds) {
    const gmail = await this.client(account);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: { ids: messageIds, removeLabelIds: ["INBOX"] },
    });
    return { account: account.alias, archived: messageIds.length };
  }

  async markRead(account, messageIds, isRead) {
    const gmail = await this.client(account);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids: messageIds,
        addLabelIds: isRead ? [] : ["UNREAD"],
        removeLabelIds: isRead ? ["UNREAD"] : [],
      },
    });
    return { account: account.alias, changed: messageIds.length, isRead };
  }

  async listLabels(account) {
    const gmail = await this.client(account);
    const response = await gmail.users.labels.list({ userId: "me" });
    return {
      account: account.alias,
      labels: (response.data.labels || []).map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type,
      })),
    };
  }

  async modifyLabels(account, messageIds, { addLabelIds = [], removeLabelIds = [] }) {
    const gmail = await this.client(account);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: { ids: messageIds, addLabelIds, removeLabelIds },
    });
    return {
      account: account.alias,
      changed: messageIds.length,
      added: addLabelIds,
      removed: removeLabelIds,
    };
  }
}
