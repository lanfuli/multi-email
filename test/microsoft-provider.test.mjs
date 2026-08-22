import assert from "node:assert/strict";
import test from "node:test";
import { emptyConfig, validateConfig } from "../src/config.mjs";
import { credentialAccountKey, MemoryCredentialStore } from "../src/keychain.mjs";
import { MicrosoftProvider } from "../src/providers/microsoft.mjs";

const account = {
  alias: "m365",
  email: "sales@example.com",
  provider: "microsoft",
};

function config() {
  const value = emptyConfig();
  value.providers.microsoft = {
    clientId: "11111111-2222-3333-4444-555555555555",
    tenant: "organizations",
  };
  value.accounts = [account];
  return validateConfig(value);
}

function provider(options = {}) {
  return new MicrosoftProvider({
    config: config(),
    credentialStore: new MemoryCredentialStore(),
    fetchImpl: async () => {
      throw new Error("Unexpected external fetch in unit test");
    },
    ...options,
  });
}

test("profile accepts only an exact configured mail or principal identity", async () => {
  const mail = provider();
  mail.graphRequest = async () => ({
    id: "user-1",
    displayName: "Sales",
    mail: "sales@example.com.evil.test",
    userPrincipalName: "other@example.com",
  });

  await assert.rejects(mail.profile(account), { code: "ACCOUNT_MISMATCH" });

  mail.graphRequest = async () => ({
    id: "user-1",
    displayName: "Sales",
    mail: null,
    userPrincipalName: "Sales@Example.COM",
  });
  assert.deepEqual(await mail.profile(account), {
    id: "user-1",
    email: "sales@example.com",
    displayName: "Sales",
    mail: null,
    userPrincipalName: "Sales@Example.COM",
  });
});

test("Graph requests reject hostname lookalikes before fetch", async () => {
  let fetchCalls = 0;
  const mail = provider({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  });

  await assert.rejects(
    mail.graphRequestWithToken(
      "not-a-real-token",
      "https://graph.microsoft.com.evil.test/v1.0/me/messages",
    ),
    { code: "INVALID_GRAPH_URL" },
  );
  assert.equal(fetchCalls, 0);
});

test("Microsoft page tokens are confined to the messages collection", async () => {
  const mail = provider();
  let graphCalls = 0;
  mail.graphRequest = async () => {
    graphCalls += 1;
    return { value: [] };
  };
  const token = Buffer.from(
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=1",
    "utf8",
  ).toString("base64url");

  await assert.rejects(
    mail.search(account, { query: "", maxResults: 1, pageToken: token }),
    { code: "INVALID_PAGE_TOKEN" },
  );
  assert.equal(graphCalls, 0);
});

test("reply draft uses createReply, patches only the draft, then reviews it", async () => {
  const mail = provider();
  const calls = [];
  mail.graphRequest = async (_account, path, options = {}) => {
    calls.push({ path, options });
    if (path === "me/messages/original%2Fid/createReply") {
      assert.equal(options.method, "POST");
      return { id: "draft/1", conversationId: "thread-1" };
    }
    if (path === "me/messages/draft%2F1?$select=id,isDraft") {
      return { id: "draft/1", isDraft: true };
    }
    if (path === "me/messages/draft%2F1") {
      assert.equal(options.method, "PATCH");
      assert.deepEqual(options.body, {
        body: { contentType: "Text", content: "Reply body" },
        ccRecipients: [{ emailAddress: { address: "copy@example.com" } }],
        bccRecipients: [{ emailAddress: { address: "audit@example.com" } }],
      });
      return null;
    }
    if (path.startsWith("me/messages/draft%2F1?$select=")) {
      return {
        id: "draft/1",
        conversationId: "thread-1",
        isDraft: true,
        toRecipients: [
          { emailAddress: { name: "Customer", address: "Customer@Example.COM" } },
        ],
        ccRecipients: [{ emailAddress: { address: "Copy@Example.COM" } }],
        bccRecipients: [{ emailAddress: { address: "Audit@Example.COM" } }],
        subject: "RE: Question",
        body: { contentType: "text", content: "Reply body" },
      };
    }
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  const result = await mail.createReplyDraft(account, {
    messageId: "original/id",
    body: "Reply body",
    cc: ["copy@example.com"],
    bcc: ["audit@example.com"],
  });

  assert.deepEqual(result, {
    account: "m365",
    provider: "microsoft",
    draftId: "draft/1",
    messageId: "draft/1",
    threadId: "thread-1",
    subject: "RE: Question",
    to: ["customer@example.com"],
    status: "draft_created",
  });
  assert.equal(calls.length, 4);
});

test("reviewDraft returns lowercased bare addresses, never display-name strings", async () => {
  const mail = provider();
  mail.graphRequest = async () => ({
    id: "draft-2",
    conversationId: "thread-2",
    isDraft: true,
    toRecipients: [{ emailAddress: { name: "One", address: "ONE@Example.COM" } }],
    ccRecipients: [{ emailAddress: { name: "Two", address: "TWO@Example.COM" } }],
    bccRecipients: [{ emailAddress: { name: "Three", address: "THREE@Example.COM" } }],
    subject: "Subject",
    body: { contentType: "Text", content: "Body" },
    lastModifiedDateTime: "2026-08-21T12:00:00Z",
  });

  const review = await mail.reviewDraft(account, "draft-2");
  assert.deepEqual(review.to, ["one@example.com"]);
  assert.deepEqual(review.cc, ["two@example.com"]);
  assert.deepEqual(review.bcc, ["three@example.com"]);
});

test("Microsoft legacy cache migrates only after silent token and profile identity checks", async () => {
  const mailConfig = config();
  const legacyCache = JSON.stringify({ Account: {}, AccessToken: {} });
  const credentialStore = new MemoryCredentialStore({}, {
    legacy: { "microsoft:m365:msal-cache": legacyCache },
  });
  const mail = new MicrosoftProvider({
    config: mailConfig,
    credentialStore,
    fetchImpl: async () => {
      throw new Error("Unexpected external fetch in unit test");
    },
  });
  const application = {
    async getAllAccounts() {
      return [{ username: "sales@example.com" }];
    },
    async acquireTokenSilent() {
      return {
        accessToken: "not-a-real-token",
        scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
      };
    },
    getTokenCache() {
      return { serialize: () => legacyCache };
    },
  };
  mail.application = async () => ({
    application,
    record: {
      key: credentialAccountKey(mailConfig, account, ":msal-cache"),
      legacyKey: "microsoft:m365:msal-cache",
      raw: legacyCache,
      source: "legacy",
    },
  });
  mail.graphRequestWithToken = async () => ({
    id: "user-1",
    mail: "sales@example.com",
    userPrincipalName: "sales@example.com",
  });

  assert.equal(await mail.accessToken(account), "not-a-real-token");
  assert.equal(
    await credentialStore.get(credentialAccountKey(mailConfig, account, ":msal-cache")),
    legacyCache,
  );
  assert.equal(await credentialStore.getLegacy("microsoft:m365:msal-cache"), legacyCache);
});

test("Microsoft identity mismatch leaves a legacy cache untouched and unmigrated", async () => {
  const mailConfig = config();
  const legacyCache = JSON.stringify({ Account: {}, AccessToken: {} });
  const credentialStore = new MemoryCredentialStore({}, {
    legacy: { "microsoft:m365:msal-cache": legacyCache },
  });
  const mail = new MicrosoftProvider({ config: mailConfig, credentialStore });
  mail.application = async () => ({
    application: {
      async getAllAccounts() {
        return [{ username: "sales@example.com" }];
      },
      async acquireTokenSilent() {
        return {
          accessToken: "not-a-real-token",
          scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
        };
      },
      getTokenCache() {
        return { serialize: () => legacyCache };
      },
    },
    record: {
      key: credentialAccountKey(mailConfig, account, ":msal-cache"),
      legacyKey: "microsoft:m365:msal-cache",
      raw: legacyCache,
      source: "legacy",
    },
  });
  mail.graphRequestWithToken = async () => ({
    mail: "attacker@example.com",
    userPrincipalName: "attacker@example.com",
  });

  await assert.rejects(mail.accessToken(account), { code: "ACCOUNT_MISMATCH" });
  assert.equal(
    await credentialStore.get(credentialAccountKey(mailConfig, account, ":msal-cache")),
    null,
  );
  assert.equal(await credentialStore.getLegacy("microsoft:m365:msal-cache"), legacyCache);
});

test("Microsoft doctor is read-only and reports explicit diagnostic dimensions", async () => {
  const mailConfig = config();
  const legacyCache = JSON.stringify({ Account: {}, AccessToken: {} });
  const credentialStore = new MemoryCredentialStore({}, {
    legacy: { "microsoft:m365:msal-cache": legacyCache },
  });
  const mail = new MicrosoftProvider({ config: mailConfig, credentialStore });
  mail.createApplication = () => ({
    async getAllAccounts() {
      return [{ username: "sales@example.com" }];
    },
    async acquireTokenSilent() {
      return {
        accessToken: "not-a-real-token",
        scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
      };
    },
  });
  mail.graphRequestWithToken = async () => ({
    id: "user-1",
    mail: "sales@example.com",
    userPrincipalName: "sales@example.com",
  });

  const diagnostic = await mail.diagnose(account);

  assert.equal(diagnostic.credential_present, true);
  assert.equal(diagnostic.token_valid, true);
  assert.equal(diagnostic.scopes_valid, true);
  assert.equal(diagnostic.identity_verified, true);
  assert.equal(diagnostic.legacy_migration_pending, true);
  assert.equal(diagnostic.status, "ok");
  assert.equal(
    await credentialStore.get(credentialAccountKey(mailConfig, account, ":msal-cache")),
    null,
  );
});
