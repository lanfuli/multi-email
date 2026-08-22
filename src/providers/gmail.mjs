import { randomBytes } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { auth as googleAuth, gmail as createGmailClient } from "@googleapis/gmail";
import { GOOGLE_SCOPES } from "../constants.mjs";
import { MultiEmailError } from "../errors.mjs";
import { credentialAccountKey, legacyCredentialAccountKey } from "../keychain.mjs";
import {
  buildRawMessage,
  extractGmailBody,
  headersToObject,
  splitAddressHeader,
} from "../mime.mjs";

const PROFILE_HEADERS = ["From", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID", "References"];
const REQUIRED_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

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
        "Google OAuth client is not configured. Run setup init with a Desktop OAuth client JSON file.",
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
        `Account '${account.alias}' is not authorized. Run setup auth ${account.alias}.`,
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
    const response = await gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "full",
    });
    const message = response.data.message || {};
    const headers = headersToObject(message.payload?.headers);
    const extracted = extractGmailBody(message.payload);
    return {
      account: account.alias,
      draftId,
      messageId: message.id,
      to: splitAddressHeader(headers.to),
      cc: splitAddressHeader(headers.cc),
      bcc: splitAddressHeader(headers.bcc),
      subject: headers.subject || "",
      body: extracted.body || extracted.htmlBody || "",
    };
  }

  async sendDraft(account, draftId) {
    const gmail = await this.client(account);
    const response = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
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
