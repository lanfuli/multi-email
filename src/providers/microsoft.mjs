import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PublicClientApplication } from "@azure/msal-node";
import { MultiEmailError } from "../errors.mjs";
import { credentialAccountKey, legacyCredentialAccountKey } from "../keychain.mjs";
import { buildRawMessage } from "../mime.mjs";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0/";
const DELEGATED_SCOPES = Object.freeze(["User.Read", "Mail.ReadWrite", "Mail.Send"]);
const BODY_LIMIT = 80_000;
const PAGE_TOKEN_LIMIT = 12_000;
const RAW_DRAFT_LIMIT = 2 * 1024 * 1024;
const MIME_HEADER_LIMIT = 128 * 1024;
const GRAPH_ERROR_BODY_LIMIT = 64 * 1024;

function credentialKey(config, account) {
  return credentialAccountKey(config, account, ":msal-cache");
}

function legacyCredentialKey(account) {
  return legacyCredentialAccountKey(account, ":msal-cache");
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

function cachePlugin(credentialStore, key, { serialized = null, persist = true } = {}) {
  return {
    async beforeCacheAccess(context) {
      const stored = serialized ?? (await credentialStore.get(key));
      if (!stored) return;

      try {
        JSON.parse(stored);
        context.tokenCache.deserialize(stored);
      } catch {
        throw new MultiEmailError(
          "The Microsoft credential cache is corrupt. Reauthorize this account.",
          "INVALID_CREDENTIAL",
        );
      }
    },

    async afterCacheAccess(context) {
      if (persist && context.cacheHasChanged) {
        await credentialStore.set(key, context.tokenCache.serialize());
      }
    },
  };
}

function compactBody(value, limit = BODY_LIMIT) {
  const body = String(value || "");
  if (body.length <= limit) return { body, truncated: false };
  return { body: `${body.slice(0, limit)}\n\n[truncated]`, truncated: true };
}

function recipient(address) {
  return { emailAddress: { address } };
}

function recipients(values) {
  return (Array.isArray(values) ? values : []).map(recipient);
}

function formatAddress(value) {
  const address = String(value?.emailAddress?.address || "");
  const name = String(value?.emailAddress?.name || "");
  if (!name || name.toLowerCase() === address.toLowerCase()) return address;
  return `${name} <${address}>`;
}

function formatAddresses(values) {
  return (Array.isArray(values) ? values : []).map(formatAddress).filter(Boolean);
}

function bareAddresses(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value?.emailAddress?.address || "").trim().toLowerCase())
    .filter(Boolean);
}

function draftNotReviewable(message, details = undefined) {
  return new MultiEmailError(message, "DRAFT_NOT_REVIEWABLE", details);
}

function draftIdentity(account, value, field, { allowDefault = false } = {}) {
  const expected = account.email.toLowerCase();
  if (value === undefined || value === null) {
    if (allowDefault) return expected;
    throw draftNotReviewable(
      `The Microsoft draft has no explicit ${field} identity, so it cannot be safely reviewed.`,
    );
  }

  const actual = String(value?.emailAddress?.address || "").trim().toLowerCase();
  if (!actual || actual !== expected) {
    throw draftNotReviewable(
      `The Microsoft draft ${field} identity does not match the configured mailbox.`,
    );
  }
  return actual;
}

function draftRecipients(values, field) {
  if (!Array.isArray(values)) {
    throw draftNotReviewable(
      `Microsoft returned an invalid ${field} recipient list for this draft.`,
    );
  }

  return values.map((value) => {
    const address = String(value?.emailAddress?.address || "").trim().toLowerCase();
    if (!address) {
      throw draftNotReviewable(
        `Microsoft returned an incomplete ${field} recipient for this draft.`,
      );
    }
    return address;
  });
}

function draftReplyTo(value) {
  if (!Array.isArray(value) || value.length !== 0) {
    throw draftNotReviewable(
      "Microsoft drafts with a Reply-To override cannot be safely reviewed.",
    );
  }
  return [];
}

function draftRevisionValue(value) {
  return typeof value === "string" && value.length ? value : null;
}

function microsoftRevision(message, rawPayloadSha256 = null) {
  return {
    messageId: message?.id ?? null,
    threadId: message?.conversationId ?? null,
    rawPayloadSha256,
    changeKey: draftRevisionValue(message?.changeKey),
    lastModifiedDateTime: draftRevisionValue(message?.lastModifiedDateTime),
  };
}

function sameMicrosoftRevision(first, second) {
  return (
    first.messageId === second.messageId &&
    first.threadId === second.threadId &&
    first.changeKey === second.changeKey &&
    first.lastModifiedDateTime === second.lastModifiedDateTime
  );
}

function hasCompleteEmptyAttachmentSnapshot(snapshot) {
  return (
    Array.isArray(snapshot?.value) &&
    snapshot.value.length === 0 &&
    snapshot?.["@odata.nextLink"] === undefined
  );
}

function draftChanged() {
  return new MultiEmailError(
    "The Microsoft draft revision changed after review. Prepare and approve it again.",
    "DRAFT_CHANGED",
  );
}

function rawDraftBytes(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw draftNotReviewable("Microsoft returned an invalid raw MIME draft.");
  }
  const raw = Buffer.from(value);
  if (raw.length > RAW_DRAFT_LIMIT) {
    throw new MultiEmailError(
      "The Microsoft raw MIME draft exceeds the 2 MB review limit.",
      "DRAFT_TOO_LARGE",
    );
  }
  return raw;
}

function mimeHeaders(raw) {
  const crlfBoundary = raw.indexOf("\r\n\r\n");
  const lfBoundary = raw.indexOf("\n\n");
  const headerEnd =
    crlfBoundary === -1
      ? lfBoundary
      : lfBoundary === -1
        ? crlfBoundary
        : Math.min(crlfBoundary, lfBoundary);
  if (headerEnd < 0 || headerEnd > MIME_HEADER_LIMIT) {
    throw draftNotReviewable("The Microsoft raw MIME draft has invalid or oversized headers.");
  }

  const headerText = raw.subarray(0, headerEnd).toString("latin1").replaceAll("\r\n", "\n");
  if (headerText.includes("\r") || headerText.includes("\0")) {
    throw draftNotReviewable("The Microsoft raw MIME draft has malformed headers.");
  }

  const unfolded = [];
  for (const line of headerText.split("\n")) {
    if (/^[ \t]/u.test(line)) {
      if (!unfolded.length) {
        throw draftNotReviewable("The Microsoft raw MIME draft has malformed header folding.");
      }
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }

  const headers = new Map();
  for (const line of unfolded) {
    const separator = line.indexOf(":");
    const name = separator > 0 ? line.slice(0, separator) : "";
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) {
      throw draftNotReviewable("The Microsoft raw MIME draft has a malformed header name.");
    }
    const key = name.toLowerCase();
    const values = headers.get(key) || [];
    values.push(line.slice(separator + 1).trim());
    headers.set(key, values);
  }
  return headers;
}

function assertReviewableMime(raw) {
  const headers = mimeHeaders(raw);
  const mimeVersions = headers.get("mime-version") || [];
  if (mimeVersions.length !== 1 || mimeVersions[0].trim() !== "1.0") {
    throw draftNotReviewable(
      "The Microsoft raw MIME draft must have one MIME-Version: 1.0 header.",
    );
  }
  const contentTypes = headers.get("content-type") || [];
  if (contentTypes.length !== 1) {
    throw draftNotReviewable(
      "The Microsoft raw MIME draft must have one explicit Content-Type header.",
    );
  }

  const contentType = contentTypes[0].trim();
  if (!/^text\/plain\s*;\s*charset\s*=\s*(?:"(?:utf-8|us-ascii)"|(?:utf-8|us-ascii))\s*$/iu.test(contentType)) {
    throw draftNotReviewable(
      "Only a single UTF-8 or US-ASCII text/plain Microsoft MIME draft can be safely reviewed.",
    );
  }
  if (
    headers.has("content-disposition") ||
    headers.has("content-id") ||
    headers.has("content-location")
  ) {
    throw draftNotReviewable(
      "The Microsoft raw MIME draft contains attachment or inline-content headers.",
    );
  }

  const transferEncodings = headers.get("content-transfer-encoding") || [];
  if (transferEncodings.length !== 1) {
    throw draftNotReviewable(
      "The Microsoft raw MIME draft must have one explicit transfer encoding.",
    );
  }
  const transferEncoding = transferEncodings[0].trim().toLowerCase();
  if (!["7bit", "8bit", "base64", "quoted-printable"].includes(transferEncoding)) {
    throw draftNotReviewable(
      "The Microsoft raw MIME draft uses an unsupported transfer encoding.",
    );
  }
  return headers;
}

function optionalMimeHeader(headers, name) {
  const values = headers.get(name.toLowerCase()) || [];
  if (values.length > 1) {
    throw draftNotReviewable(`The Microsoft raw MIME draft has duplicate ${name} headers.`);
  }
  const value = values[0]?.trim() || "";
  if (/[\r\n\0]/u.test(value) || value.length > 4096) {
    throw draftNotReviewable(`The Microsoft raw MIME draft has an invalid ${name} header.`);
  }
  return value;
}

function frozenManifest(account, draftId, value) {
  const revision = value?.providerRevision;
  const body = value?.body;
  const bodySha256 = typeof body === "string"
    ? createHash("sha256").update(body, "utf8").digest("hex")
    : null;
  const valid =
    value &&
    typeof value === "object" &&
    value.manifestVersion === 1 &&
    value.policyVersion === 2 &&
    value.account === account.alias &&
    value.provider === "microsoft" &&
    value.authenticatedPrincipal === account.email &&
    value.mailboxResource === account.email &&
    value.draftId === draftId &&
    value.from === account.email &&
    value.sender === account.email &&
    Array.isArray(value.replyTo) &&
    value.replyTo.length === 0 &&
    Array.isArray(value.to) &&
    Array.isArray(value.cc) &&
    Array.isArray(value.bcc) &&
    value.to.length + value.cc.length + value.bcc.length > 0 &&
    typeof value.subject === "string" &&
    typeof value.inReplyTo === "string" &&
    typeof value.references === "string" &&
    typeof body === "string" &&
    value.bodySha256 === bodySha256 &&
    value.bodyFormat === "text" &&
    Array.isArray(value.attachments) &&
    value.attachments.length === 0 &&
    value.completeness === "complete" &&
    revision &&
    typeof revision === "object" &&
    revision.messageId === value.messageId &&
    revision.threadId === value.threadId &&
    typeof revision.rawPayloadSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(revision.rawPayloadSha256) &&
    typeof revision.changeKey === "string" &&
    revision.changeKey.length > 0 &&
    typeof revision.lastModifiedDateTime === "string" &&
    revision.lastModifiedDateTime.length > 0;
  if (!valid) throw draftChanged();
  return { manifest: value, revision };
}

async function readBoundedResponse(
  response,
  limit,
  {
    message = "The Microsoft Graph response exceeds its safety limit.",
    code = "INVALID_PROVIDER_RESPONSE",
  } = {},
) {
  const contentLength = response.headers?.get?.("content-length");
  if (/^\d+$/u.test(String(contentLength || "")) && Number(contentLength) > limit) {
    throw new MultiEmailError(message, code);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > limit) throw new MultiEmailError(message, code);
    return value;
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The response is already being abandoned because it exceeded the cap.
        }
        throw new MultiEmailError(message, code);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

function profileEmails(profile) {
  return [profile?.mail, profile?.userPrincipalName]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function assertProfileMatches(account, profile) {
  const expected = account.email.toLowerCase();
  const actual = profileEmails(profile);
  if (!actual.includes(expected)) {
    throw new MultiEmailError(
      `Authenticated '${actual.join(" / ") || "unknown"}', but '${expected}' was expected. Refusing to use this mailbox.`,
      "ACCOUNT_MISMATCH",
    );
  }
}

function hasRequiredScopes(scopes) {
  const granted = new Set(
    (Array.isArray(scopes) ? scopes : String(scopes || "").split(/\s+/))
      .map((scope) => String(scope).trim().toLowerCase())
      .filter(Boolean),
  );
  return DELEGATED_SCOPES.every((scope) => granted.has(scope.toLowerCase()));
}

function encodePageToken(nextLink) {
  return nextLink ? Buffer.from(nextLink, "utf8").toString("base64url") : null;
}

function decodePageToken(pageToken) {
  if (!pageToken) return null;
  if (typeof pageToken !== "string" || pageToken.length > PAGE_TOKEN_LIMIT) {
    throw new MultiEmailError("Invalid Microsoft page token.", "INVALID_PAGE_TOKEN");
  }

  let decoded;
  try {
    decoded = Buffer.from(pageToken, "base64url").toString("utf8");
  } catch {
    throw new MultiEmailError("Invalid Microsoft page token.", "INVALID_PAGE_TOKEN");
  }

  const roundTrip = Buffer.from(decoded, "utf8").toString("base64url");
  if (roundTrip !== pageToken.replace(/=+$/, "")) {
    throw new MultiEmailError("Invalid Microsoft page token.", "INVALID_PAGE_TOKEN");
  }

  const url = graphUrl(decoded);
  if (url.pathname !== "/v1.0/me/messages") {
    throw new MultiEmailError("The Microsoft page token targets an unexpected resource.", "INVALID_PAGE_TOKEN");
  }
  return url;
}

function graphUrl(pathOrUrl) {
  let url;
  try {
    url = /^https:/i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(String(pathOrUrl || "").replace(/^\/+/, ""), GRAPH_BASE_URL);
  } catch {
    throw new MultiEmailError("Invalid Microsoft Graph URL.", "INVALID_GRAPH_URL");
  }

  if (url.protocol !== "https:" || url.origin !== "https://graph.microsoft.com") {
    throw new MultiEmailError("Refusing to call a non-Microsoft Graph URL.", "INVALID_GRAPH_URL");
  }
  if (!url.pathname.startsWith("/v1.0/")) {
    throw new MultiEmailError("Refusing to call an unsupported Microsoft Graph API version.", "INVALID_GRAPH_URL");
  }
  return url;
}

function graphErrorDetails(response, payload) {
  return {
    status: response.status,
    providerCode: payload?.error?.code || null,
    retryAfter: response.headers.get("retry-after") || null,
  };
}

function searchExpression(query) {
  const escaped = String(query || "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return escaped ? `"${escaped}"` : "";
}

function messageSummary(account, message) {
  return {
    account: account.alias,
    id: message.id,
    threadId: message.conversationId || null,
    from: formatAddress(message.from),
    to: formatAddresses(message.toRecipients).join(", "),
    subject: message.subject || "",
    date: message.receivedDateTime || message.sentDateTime || "",
    snippet: message.bodyPreview || "",
    labels: message.categories || [],
    isRead: Boolean(message.isRead),
  };
}

export class MicrosoftProvider {
  constructor({ config, credentialStore, browserOpener = openBrowser, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.credentialStore = credentialStore;
    this.browserOpener = browserOpener;
    this.fetchImpl = fetchImpl;
    this.applications = new Map();
    this.verifiedAliases = new Set();
  }

  providerConfig() {
    const provider = this.config.providers.microsoft || {};
    if (!provider.clientId) {
      throw new MultiEmailError(
        "Microsoft OAuth is not configured. Add the public desktop app client ID during setup.",
        "MICROSOFT_CLIENT_NOT_CONFIGURED",
      );
    }

    const tenant = String(provider.tenant || "organizations").trim();
    if (!tenant || /[\s/?#]/.test(tenant)) {
      throw new MultiEmailError("Invalid Microsoft tenant value in config.", "INVALID_CONFIG");
    }
    return {
      clientId: provider.clientId,
      tenant,
      authority: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`,
    };
  }

  createApplication(account, { persist = true, serialized = null } = {}) {
    const provider = this.providerConfig();
    return new PublicClientApplication({
      auth: {
        clientId: provider.clientId,
        authority: provider.authority,
      },
      cache: persist
        ? {
            cachePlugin: cachePlugin(
              this.credentialStore,
              credentialKey(this.config, account),
            ),
          }
        : serialized
          ? {
              cachePlugin: cachePlugin(
                this.credentialStore,
                credentialKey(this.config, account),
                { serialized, persist: false },
              ),
            }
          : undefined,
    });
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

  async application(account) {
    let entry = this.applications.get(account.alias);
    if (!entry) {
      const record = await this.credentialRecord(account);
      const application =
        record?.source === "legacy"
          ? this.createApplication(account, { persist: false, serialized: record.raw })
          : this.createApplication(account);
      entry = { application, record };
      this.applications.set(account.alias, entry);
    }
    return entry;
  }

  async isAuthenticated(account) {
    return (await this.credentialRecord(account)) !== null;
  }

  async authorize(account, { onInstruction = console.log } = {}) {
    const application = this.createApplication(account, { persist: false });
    onInstruction(`Opening Microsoft authorization for ${account.alias} (${account.email})...`);
    onInstruction(
      "If Microsoft says admin approval is required, a GoDaddy/Microsoft 365 Global Admin must grant consent.",
    );

    let result;
    try {
      result = await application.acquireTokenInteractive({
        scopes: [...DELEGATED_SCOPES],
        loginHint: account.email,
        prompt: "select_account",
        openBrowser: this.browserOpener,
        successTemplate:
          "<!doctype html><meta charset=utf-8><title>Multi Email</title><h1>Authorization complete</h1><p>You may close this window.</p>",
        errorTemplate:
          "<!doctype html><meta charset=utf-8><title>Multi Email</title><h1>Authorization failed</h1><p>Return to the terminal for details.</p>",
      });
    } catch (error) {
      throw new MultiEmailError(
        "Microsoft authorization was not completed. Check the account selection and consent policy, then try again.",
        "MICROSOFT_AUTH_FAILED",
        { providerCode: error?.errorCode || error?.code || null },
      );
    }

    if (!result?.accessToken) {
      throw new MultiEmailError("Microsoft returned no access token.", "MISSING_ACCESS_TOKEN");
    }
    if (result.scopes && !hasRequiredScopes(result.scopes)) {
      throw new MultiEmailError(
        "Microsoft did not grant all required mail scopes. Nothing was saved.",
        "INSUFFICIENT_SCOPES",
      );
    }

    // Persist only after /me proves that the chosen identity belongs to this configured alias.
    const profile = await this.graphRequestWithToken(result.accessToken, "me?$select=id,displayName,mail,userPrincipalName");
    assertProfileMatches(account, profile);
    await this.credentialStore.set(
      credentialKey(this.config, account),
      application.getTokenCache().serialize(),
    );
    this.applications.delete(account.alias);
    this.verifiedAliases.delete(account.alias);

    return {
      alias: account.alias,
      email: account.email,
      provider: "microsoft",
      displayName: profile.displayName || "",
      tenantId: result.tenantId || null,
      homeAccountId: result.account?.homeAccountId || null,
    };
  }

  async accessToken(account) {
    const { application, record } = await this.application(account);
    let accounts;
    try {
      accounts = await application.getAllAccounts();
    } catch (error) {
      if (error instanceof MultiEmailError) throw error;
      throw new MultiEmailError(
        `Unable to load the Microsoft credential for '${account.alias}'. Reauthorize this account.`,
        "INVALID_CREDENTIAL",
      );
    }

    if (!accounts.length) {
      throw new MultiEmailError(
        `Account '${account.alias}' is not authorized. Run setup auth ${account.alias}.`,
        "NOT_AUTHENTICATED",
      );
    }

    const expected = account.email.toLowerCase();
    const selected =
      accounts.find((candidate) => String(candidate.username || "").toLowerCase() === expected) ||
      (accounts.length === 1 ? accounts[0] : null);
    if (!selected) {
      throw new MultiEmailError(
        `The Microsoft credential cache for '${account.alias}' contains multiple identities. Reauthorize it.`,
        "AMBIGUOUS_CREDENTIAL",
      );
    }

    let result;
    try {
      result = await application.acquireTokenSilent({
        account: selected,
        scopes: [...DELEGATED_SCOPES],
      });
    } catch (error) {
      throw new MultiEmailError(
        `Microsoft authorization for '${account.alias}' must be refreshed. Run setup auth ${account.alias}.`,
        "REAUTHENTICATION_REQUIRED",
        { providerCode: error?.errorCode || error?.code || null },
      );
    }

    if (!result?.accessToken) {
      throw new MultiEmailError("Microsoft returned no access token.", "MISSING_ACCESS_TOKEN");
    }

    if (result.scopes && !hasRequiredScopes(result.scopes)) {
      throw new MultiEmailError(
        `Microsoft authorization for '${account.alias}' is missing required mail scopes. Reauthorize it.`,
        "INSUFFICIENT_SCOPES",
      );
    }

    if (!this.verifiedAliases.has(account.alias)) {
      const profile = await this.graphRequestWithToken(
        result.accessToken,
        "me?$select=id,displayName,mail,userPrincipalName",
      );
      assertProfileMatches(account, profile);
      this.verifiedAliases.add(account.alias);
    }
    if (record?.source === "legacy") {
      // Copy only after both silent token acquisition and /me identity verification.
      await this.credentialStore.set(
        record.key,
        application.getTokenCache().serialize(),
      );
      this.applications.delete(account.alias);
    }
    return result.accessToken;
  }

  async diagnose(account) {
    const diagnostic = {
      alias: account.alias,
      provider: "microsoft",
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

      const application = this.createApplication(account, {
        persist: false,
        serialized: record.raw,
      });
      let accounts;
      try {
        accounts = await application.getAllAccounts();
      } catch {
        diagnostic.token_valid = false;
        diagnostic.status = "invalid_credential";
        diagnostic.error_code = "INVALID_CREDENTIAL";
        return diagnostic;
      }
      if (!accounts.length) {
        diagnostic.token_valid = false;
        diagnostic.status = "invalid_credential";
        diagnostic.error_code = "INVALID_CREDENTIAL";
        return diagnostic;
      }

      const expected = account.email.toLowerCase();
      const selected =
        accounts.find((candidate) => String(candidate.username || "").toLowerCase() === expected) ||
        (accounts.length === 1 ? accounts[0] : null);
      if (!selected) {
        diagnostic.token_valid = null;
        diagnostic.identity_verified = false;
        diagnostic.status = "identity_mismatch";
        diagnostic.error_code = "AMBIGUOUS_CREDENTIAL";
        return diagnostic;
      }

      let result;
      try {
        result = await application.acquireTokenSilent({
          account: selected,
          scopes: [...DELEGATED_SCOPES],
        });
        if (!result?.accessToken) throw new Error("missing access token");
        diagnostic.token_valid = true;
      } catch {
        diagnostic.token_valid = false;
        diagnostic.status = "reauthorization_required";
        diagnostic.error_code = "REAUTHENTICATION_REQUIRED";
        return diagnostic;
      }

      diagnostic.scopes_valid = hasRequiredScopes(result.scopes);
      if (!diagnostic.scopes_valid) {
        diagnostic.status = "insufficient_scopes";
        diagnostic.error_code = "INSUFFICIENT_SCOPES";
        return diagnostic;
      }

      try {
        const profile = await this.graphRequestWithToken(
          result.accessToken,
          "me?$select=id,displayName,mail,userPrincipalName",
        );
        assertProfileMatches(account, profile);
        diagnostic.identity_verified = true;
        diagnostic.status = "ok";
      } catch (error) {
        diagnostic.identity_verified = error?.code === "ACCOUNT_MISMATCH" ? false : null;
        diagnostic.status =
          diagnostic.identity_verified === false ? "identity_mismatch" : "provider_unavailable";
        diagnostic.error_code = error?.code || "MICROSOFT_PROFILE_FAILED";
      }
      return diagnostic;
    } catch (error) {
      diagnostic.status = "configuration_error";
      diagnostic.error_code = error?.code || "MICROSOFT_CLIENT_NOT_CONFIGURED";
      return diagnostic;
    }
  }

  async logout(account) {
    const key = credentialKey(this.config, account);
    const removed = await this.credentialStore.delete(key);
    this.applications.delete(account.alias);
    this.verifiedAliases.delete(account.alias);

    let legacyRemoved = false;
    let legacyPreserved = false;
    if (typeof this.credentialStore.getLegacy === "function") {
      const legacyKey = legacyCredentialKey(account);
      const legacy = await this.credentialStore.getLegacy(legacyKey);
      if (legacy !== null) {
        const diagnostic = await this.diagnose(account);
        if (
          diagnostic.credential_source === "legacy" &&
          diagnostic.token_valid === true &&
          diagnostic.identity_verified === true &&
          diagnostic.scopes_valid === true
        ) {
          legacyRemoved = await this.credentialStore.deleteLegacy(legacyKey);
        } else {
          // The historical namespace was shared across configs. Preserve an
          // entry that cannot be conclusively tied to this configured mailbox.
          legacyPreserved = true;
        }
      }
    }

    return {
      alias: account.alias,
      provider: "microsoft",
      local_credential_removed: Boolean(removed),
      verified_legacy_credential_removed: Boolean(legacyRemoved),
      unverified_legacy_credential_preserved: legacyPreserved,
    };
  }

  async revoke(account) {
    return {
      alias: account.alias,
      provider: "microsoft",
      provider_grant_revoked: false,
      manual_action_required: true,
      instruction:
        "Microsoft does not expose a safe per-app delegated-token revocation through this client. Remove Multi Email access in Microsoft My Apps, then run setup logout for this alias.",
    };
  }

  async graphRequestWithToken(
    accessToken,
    pathOrUrl,
    {
      method = "GET",
      headers = {},
      body,
      rawBody = false,
      responseType = "json",
      maxResponseBytes = undefined,
    } = {},
  ) {
    const url = graphUrl(pathOrUrl);
    const requestHeaders = {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      prefer: 'IdType="ImmutableId"',
      ...headers,
    };
    if (body !== undefined && !rawBody) requestHeaders["content-type"] = "application/json";

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body),
      });
    } catch {
      throw new MultiEmailError(
        "The Microsoft Graph request did not return a response.",
        "MICROSOFT_NETWORK_ERROR",
      );
    }

    if (responseType === "buffer") {
      if (!response.ok) {
        const errorBytes = await readBoundedResponse(response, GRAPH_ERROR_BODY_LIMIT);
        let errorPayload = null;
        try {
          errorPayload = JSON.parse(errorBytes.toString("utf8"));
        } catch {
          // Preserve the status even when Graph did not return its normal JSON error shape.
        }
        const code =
          response.status === 401 ? "REAUTHENTICATION_REQUIRED" : "MICROSOFT_GRAPH_ERROR";
        throw new MultiEmailError(
          `Microsoft Graph rejected the request (${response.status}).`,
          code,
          graphErrorDetails(response, errorPayload),
        );
      }
      if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
        throw new MultiEmailError(
          "A positive response limit is required for binary Graph requests.",
          "INVALID_INPUT",
        );
      }
      return readBoundedResponse(response, maxResponseBytes, {
        message: "The Microsoft raw MIME draft exceeds the 2 MB review limit.",
        code: "DRAFT_TOO_LARGE",
      });
    }
    if (responseType !== "json") {
      throw new MultiEmailError("Unsupported Microsoft Graph response type.", "INVALID_INPUT");
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new MultiEmailError(
            "Microsoft Graph returned an invalid response.",
            "INVALID_PROVIDER_RESPONSE",
          );
        }
      }
    }

    if (!response.ok) {
      const code = response.status === 401 ? "REAUTHENTICATION_REQUIRED" : "MICROSOFT_GRAPH_ERROR";
      throw new MultiEmailError(
        `Microsoft Graph rejected the request (${response.status}).`,
        code,
        graphErrorDetails(response, payload),
      );
    }
    return payload;
  }

  async graphRequest(account, pathOrUrl, options) {
    return this.graphRequestWithToken(await this.accessToken(account), pathOrUrl, options);
  }

  async profile(account) {
    const profile = await this.graphRequest(
      account,
      "me?$select=id,displayName,mail,userPrincipalName",
    );
    assertProfileMatches(account, profile);
    return {
      id: profile.id,
      email: account.email,
      displayName: profile.displayName || "",
      mail: profile.mail || null,
      userPrincipalName: profile.userPrincipalName || null,
    };
  }

  async search(account, { query = "", maxResults = 25, pageToken = null }) {
    let url = decodePageToken(pageToken);
    if (!url) {
      url = graphUrl("me/messages");
      url.searchParams.set("$top", String(maxResults));
      url.searchParams.set(
        "$select",
        "id,conversationId,from,toRecipients,subject,receivedDateTime,sentDateTime,bodyPreview,categories,isRead",
      );
      const expression = searchExpression(query);
      if (expression) {
        url.searchParams.set("$search", expression);
      } else {
        url.searchParams.set("$orderby", "receivedDateTime desc");
      }
    }

    const response = await this.graphRequest(account, url.href, {
      headers: { ConsistencyLevel: "eventual" },
    });
    const messages = (response?.value || []).map((message) => messageSummary(account, message));
    return {
      account: account.alias,
      messages,
      nextPageToken: encodePageToken(response?.["@odata.nextLink"]),
      resultSizeEstimate: response?.["@odata.count"] ?? null,
    };
  }

  async getMessage(account, messageId) {
    const id = encodeURIComponent(messageId);
    const message = await this.graphRequest(
      account,
      `me/messages/${id}?$select=id,conversationId,from,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,sentDateTime,categories,body,hasAttachments,isRead`,
      { headers: { prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } },
    );
    const compact = compactBody(message.body?.content);
    let attachmentNames = [];
    if (message.hasAttachments) {
      const attachments = await this.graphRequest(
        account,
        `me/messages/${id}/attachments?$top=50&$select=id,name,contentType,size,isInline`,
      );
      attachmentNames = (attachments?.value || [])
        .filter((attachment) => !attachment.isInline && attachment.name)
        .map((attachment) => attachment.name);
    }

    return {
      account: account.alias,
      id: message.id,
      threadId: message.conversationId || null,
      from: formatAddress(message.from),
      to: formatAddresses(message.toRecipients).join(", "),
      cc: formatAddresses(message.ccRecipients).join(", "),
      bcc: formatAddresses(message.bccRecipients).join(", "),
      subject: message.subject || "",
      date: message.receivedDateTime || message.sentDateTime || "",
      labels: message.categories || [],
      body: compact.body,
      bodyFormat: String(message.body?.contentType || "text").toLowerCase(),
      truncated: compact.truncated,
      attachmentNames,
      isRead: Boolean(message.isRead),
    };
  }

  async createDraft(account, input) {
    if (input.replyToMessageId) {
      return this.createReplyDraft(account, {
        messageId: input.replyToMessageId,
        body: input.body,
        cc: input.cc,
        bcc: input.bcc,
      });
    }

    const draft = await this.graphRequest(account, "me/messages", {
      method: "POST",
      body: {
        subject: input.subject || "",
        body: {
          contentType: input.bodyFormat === "html" ? "HTML" : "Text",
          content: input.body || "",
        },
        toRecipients: recipients(input.to),
        ccRecipients: recipients(input.cc),
        bccRecipients: recipients(input.bcc),
      },
    });
    return {
      account: account.alias,
      provider: "microsoft",
      draftId: draft.id,
      messageId: draft.id,
      threadId: draft.conversationId || null,
      subject: draft.subject || input.subject || "",
      to: bareAddresses(draft.toRecipients).length ? bareAddresses(draft.toRecipients) : input.to || [],
      status: "draft_created",
    };
  }

  async createReplyDraft(account, { messageId, body = "", cc = [], bcc = [] }) {
    const draft = await this.graphRequest(
      account,
      `me/messages/${encodeURIComponent(messageId)}/createReply`,
      { method: "POST" },
    );
    const updates = {
      body,
    };
    if (cc.length) updates.cc = cc;
    if (bcc.length) updates.bcc = bcc;
    await this.updateDraft(account, draft.id, updates);
    const reviewed = await this.reviewDraft(account, draft.id);
    return {
      account: account.alias,
      provider: "microsoft",
      draftId: draft.id,
      messageId: draft.id,
      threadId: draft.conversationId || null,
      subject: reviewed.subject,
      to: reviewed.to,
      status: "draft_created",
    };
  }

  async updateDraft(account, draftId, input) {
    const id = encodeURIComponent(draftId);
    const existing = await this.graphRequest(account, `me/messages/${id}?$select=id,isDraft`);
    if (!existing.isDraft) {
      throw new MultiEmailError("Only Microsoft draft messages can be updated.", "NOT_A_DRAFT");
    }

    const patch = {};
    if (Object.hasOwn(input, "subject")) patch.subject = input.subject || "";
    if (Object.hasOwn(input, "body")) {
      patch.body = {
        contentType: input.bodyFormat === "html" ? "HTML" : "Text",
        content: input.body || "",
      };
    }
    if (Object.hasOwn(input, "to")) patch.toRecipients = recipients(input.to);
    if (Object.hasOwn(input, "cc")) patch.ccRecipients = recipients(input.cc);
    if (Object.hasOwn(input, "bcc")) patch.bccRecipients = recipients(input.bcc);
    if (!Object.keys(patch).length) return { account: account.alias, draftId, status: "unchanged" };

    await this.graphRequest(account, `me/messages/${id}`, { method: "PATCH", body: patch });
    return { account: account.alias, draftId, status: "draft_updated" };
  }

  async rawDraftMime(account, encodedDraftId) {
    const value = await this.graphRequest(
      account,
      `me/messages/${encodedDraftId}/$value`,
      {
        headers: { accept: "message/rfc822" },
        responseType: "buffer",
        maxResponseBytes: RAW_DRAFT_LIMIT,
      },
    );
    return rawDraftBytes(value);
  }

  async draftRevisionSnapshot(account, encodedDraftId) {
    return this.graphRequest(
      account,
      `me/messages/${encodedDraftId}?$select=id,conversationId,isDraft,changeKey,lastModifiedDateTime`,
    );
  }

  async draftAttachmentSnapshot(account, encodedDraftId) {
    return this.graphRequest(
      account,
      `me/messages/${encodedDraftId}/attachments?$top=1&$select=id,name,contentType,size,isInline`,
    );
  }

  async reviewDraft(account, draftId) {
    const id = encodeURIComponent(draftId);
    const draft = await this.graphRequest(
      account,
      `me/messages/${id}?$select=id,conversationId,isDraft,from,sender,replyTo,toRecipients,ccRecipients,bccRecipients,subject,body,hasAttachments,importance,isReadReceiptRequested,isDeliveryReceiptRequested,changeKey,lastModifiedDateTime`,
      { headers: { prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } },
    );
    if (!draft.isDraft) {
      throw new MultiEmailError("The selected Microsoft message is no longer a draft.", "NOT_A_DRAFT");
    }
    if (draft.id !== draftId) {
      throw draftNotReviewable(
        "Microsoft returned an unexpected message identity for this draft.",
      );
    }
    if (typeof draft.conversationId !== "string" || !draft.conversationId) {
      throw draftNotReviewable(
        "Microsoft returned no complete conversation identity for this draft.",
      );
    }
    if (
      draft.importance !== "normal" ||
      draft.isReadReceiptRequested !== false ||
      draft.isDeliveryReceiptRequested !== false
    ) {
      throw draftNotReviewable(
        "Microsoft drafts with priority or receipt-request semantics cannot be safely reviewed.",
      );
    }
    const initialRevision = microsoftRevision(draft);
    if (!initialRevision.changeKey || !initialRevision.lastModifiedDateTime) {
      throw draftNotReviewable(
        "Microsoft returned no complete revision marker for this draft.",
      );
    }

    const raw = await this.rawDraftMime(account, id);

    // hasAttachments does not include inline attachments, so enumerate the
    // collection unconditionally and reject both content and pagination.
    const attachments = await this.draftAttachmentSnapshot(account, id);
    const finalDraft = await this.draftRevisionSnapshot(account, id);
    const finalRevision = microsoftRevision(finalDraft);
    if (
      finalDraft?.isDraft !== true ||
      !finalRevision.changeKey ||
      !finalRevision.lastModifiedDateTime ||
      !sameMicrosoftRevision(initialRevision, finalRevision)
    ) {
      throw draftChanged();
    }
    if (!hasCompleteEmptyAttachmentSnapshot(attachments)) {
      throw draftNotReviewable(
        "Microsoft drafts with attachments or incomplete attachment enumeration cannot be safely reviewed.",
      );
    }

    const rawHeaders = assertReviewableMime(raw);
    const projectedBodyFormat = String(draft.body?.contentType || "").trim().toLowerCase();
    if (projectedBodyFormat !== "text") {
      throw draftNotReviewable(
        "Microsoft did not return the requested plain-text draft projection.",
      );
    }
    if (
      !draft.body ||
      typeof draft.body !== "object" ||
      Array.isArray(draft.body) ||
      typeof draft.body.content !== "string"
    ) {
      throw draftNotReviewable("Microsoft returned an invalid draft body.");
    }
    if (typeof draft.subject !== "string") {
      throw draftNotReviewable("Microsoft returned an invalid draft subject.");
    }
    const body = draft.body.content;
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
      throw new MultiEmailError(
        "The Microsoft draft body exceeds the 1 MB review limit.",
        "DRAFT_TOO_LARGE",
      );
    }

    const from = draftIdentity(account, draft.from, "From");
    const sender = draftIdentity(account, draft.sender, "Sender", { allowDefault: true });
    const replyTo = draftReplyTo(draft.replyTo);
    const rawPayloadSha256 = createHash("sha256").update(raw).digest("hex");

    return {
      account: account.alias,
      draftId: draft.id,
      messageId: draft.id,
      threadId: draft.conversationId || null,
      from,
      sender,
      replyTo,
      to: draftRecipients(draft.toRecipients, "To"),
      cc: draftRecipients(draft.ccRecipients, "Cc"),
      bcc: draftRecipients(draft.bccRecipients, "Bcc"),
      subject: draft.subject,
      inReplyTo: optionalMimeHeader(rawHeaders, "In-Reply-To"),
      references: optionalMimeHeader(rawHeaders, "References"),
      body,
      bodyFormat: "text",
      attachments: [],
      completeness: "complete",
      truncated: false,
      rawPayloadSha256,
      changeKey: initialRevision.changeKey,
      lastModifiedDateTime: initialRevision.lastModifiedDateTime,
    };
  }

  async sendDraft(account, draftId, expectedManifest) {
    const id = encodeURIComponent(draftId);
    const { manifest, revision: expectedRevision } = frozenManifest(
      account,
      draftId,
      expectedManifest,
    );
    let mimeBase64;
    try {
      const frozenRaw = buildRawMessage({
        from: manifest.from,
        to: manifest.to,
        cc: manifest.cc,
        bcc: manifest.bcc,
        subject: manifest.subject,
        body: manifest.body,
        inReplyTo: manifest.inReplyTo || undefined,
        references: manifest.references || undefined,
      });
      mimeBase64 = Buffer.from(frozenRaw, "base64url").toString("base64");
    } catch {
      throw draftChanged();
    }
    try {
      const before = await this.draftRevisionSnapshot(account, id);
      const beforeRevision = microsoftRevision(before);
      let raw;
      try {
        raw = await this.rawDraftMime(account, id);
        assertReviewableMime(raw);
      } catch (error) {
        if (error?.code === "DRAFT_NOT_REVIEWABLE" || error?.code === "DRAFT_TOO_LARGE") {
          throw draftChanged();
        }
        throw error;
      }
      const attachments = await this.draftAttachmentSnapshot(account, id);
      const after = await this.draftRevisionSnapshot(account, id);
      const current = microsoftRevision(
        after,
        createHash("sha256").update(raw).digest("hex"),
      );
      const changed =
        before?.isDraft !== true ||
        after?.isDraft !== true ||
        !beforeRevision.changeKey ||
        !beforeRevision.lastModifiedDateTime ||
        !current.changeKey ||
        !current.lastModifiedDateTime ||
        !hasCompleteEmptyAttachmentSnapshot(attachments) ||
        !sameMicrosoftRevision(beforeRevision, current) ||
        current.messageId !== (expectedRevision.messageId ?? null) ||
        current.threadId !== (expectedRevision.threadId ?? null) ||
        current.rawPayloadSha256 !== (expectedRevision.rawPayloadSha256 ?? null) ||
        current.changeKey !== (expectedRevision.changeKey ?? null) ||
        current.lastModifiedDateTime !== (expectedRevision.lastModifiedDateTime ?? null);
      if (changed) {
        throw draftChanged();
      }
    } catch (error) {
      if (error?.code === "DRAFT_CHANGED") throw error;
      throw new MultiEmailError(
        "The Microsoft draft could not be verified before sending. Prepare and approve it again.",
        "SEND_VERIFICATION_FAILED",
        { causeCode: error?.code || null },
      );
    }

    // Freeze the approved allowlisted fields into the one send request. Graph's
    // existing-draft send action has no conditional revision header, so it
    // cannot prevent another client changing the draft between a GET and POST.
    await this.graphRequest(account, "me/sendMail", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "text/plain" },
      body: mimeBase64,
      rawBody: true,
    });
    return {
      account: account.alias,
      provider: "microsoft",
      draftId,
      sentMessageId: null,
      sourceDraftRetained: true,
      status: "send_accepted",
    };
  }

  async archive(account, messageIds) {
    const folder = await this.graphRequest(account, "me/mailFolders/archive?$select=id,displayName");
    let archived = 0;
    let moved = 0;
    for (const messageId of messageIds) {
      try {
        const id = encodeURIComponent(messageId);
        const message = await this.graphRequest(
          account,
          `me/messages/${id}?$select=id,parentFolderId`,
        );
        if (message.parentFolderId !== folder.id) {
          await this.graphRequest(account, `me/messages/${id}/move`, {
            method: "POST",
            body: { destinationId: folder.id },
          });
          moved += 1;
        }
        archived += 1;
      } catch (error) {
        throw new MultiEmailError(
          `Microsoft archived ${archived} of ${messageIds.length} messages before an error occurred.`,
          "PARTIAL_ARCHIVE",
          { archived, requested: messageIds.length, causeCode: error?.code || null },
        );
      }
    }
    return { account: account.alias, archived, moved };
  }

  async markRead(account, messageIds, isRead) {
    let changed = 0;
    for (const messageId of messageIds) {
      try {
        await this.graphRequest(account, `me/messages/${encodeURIComponent(messageId)}`, {
          method: "PATCH",
          body: { isRead: Boolean(isRead) },
        });
        changed += 1;
      } catch (error) {
        throw new MultiEmailError(
          `Microsoft updated ${changed} of ${messageIds.length} messages before an error occurred.`,
          "PARTIAL_MARK_READ",
          { changed, requested: messageIds.length, isRead: Boolean(isRead), causeCode: error?.code || null },
        );
      }
    }
    return { account: account.alias, changed, isRead: Boolean(isRead) };
  }

  async listCategories(account) {
    throw new MultiEmailError(
      "Listing the Outlook master category catalog requires MailboxSettings.Read, which this least-privilege connection intentionally does not request.",
      "UNSUPPORTED_OPERATION",
      { account: account.alias },
    );
  }

  async modifyCategories(account, messageIds, { add = [], remove = [] } = {}) {
    const additions = new Set(add);
    const removals = new Set(remove);
    let changed = 0;
    for (const messageId of messageIds) {
      try {
        const id = encodeURIComponent(messageId);
        const message = await this.graphRequest(account, `me/messages/${id}?$select=id,categories`);
        const categories = new Set(message.categories || []);
        for (const name of additions) categories.add(name);
        for (const name of removals) categories.delete(name);
        await this.graphRequest(account, `me/messages/${id}`, {
          method: "PATCH",
          body: { categories: [...categories] },
        });
        changed += 1;
      } catch (error) {
        throw new MultiEmailError(
          `Microsoft updated categories on ${changed} of ${messageIds.length} messages before an error occurred.`,
          "PARTIAL_CATEGORY_UPDATE",
          { changed, requested: messageIds.length, causeCode: error?.code || null },
        );
      }
    }
    return {
      account: account.alias,
      changed,
      added: [...additions],
      removed: [...removals],
    };
  }

  async listLabels(account) {
    const result = await this.listCategories(account);
    return {
      account: result.account,
      labels: result.categories.map((category) => ({ ...category, type: "category" })),
    };
  }

  async modifyLabels(account, messageIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
    return this.modifyCategories(account, messageIds, {
      add: addLabelIds,
      remove: removeLabelIds,
    });
  }
}
