import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { auth as googleAuth } from "@googleapis/gmail";
import { credentialAccountKey, MemoryCredentialStore } from "../src/keychain.mjs";
import { closeHttpServer, GmailProvider } from "../src/providers/gmail.mjs";

const account = { alias: "gmail-test", email: "owner@example.com", provider: "google" };

function config() {
  return {
    profileId: "test-profile-gmail",
    providers: {
      google: {
        clientId: "test-client.apps.googleusercontent.com",
        clientSecret: "test-client-secret",
      },
    },
  };
}

function beforeDeadline(promise, message, timeoutMs = 500) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test("closeHttpServer terminates an active loopback connection and waits for close", async () => {
  const server = http.createServer((_req, res) => res.end("unused"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const socket = net.createConnection({
    host: "127.0.0.1",
    port: server.address().port,
  });
  socket.on("error", () => {});
  await once(socket, "connect");
  const socketClosed = new Promise((resolve) => socket.once("close", resolve));

  // Leave an HTTP request incomplete so server.close() alone cannot treat this
  // connection as an idle keep-alive socket.
  socket.write("GET /oauth/google/callback HTTP/1.1\r\nHost: 127.0.0.1\r\n");

  try {
    await beforeDeadline(
      closeHttpServer(server),
      "OAuth callback server did not close its active connection",
    );
    await beforeDeadline(socketClosed, "OAuth callback socket remained open");
    assert.equal(server.listening, false);
  } finally {
    socket.destroy();
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("authorize closes the callback server before propagating a browser opener error", async (context) => {
  const createServer = http.createServer.bind(http);
  const events = [];
  let callbackServer;
  const instructions = [];
  context.mock.method(http, "createServer", (...args) => {
    callbackServer = createServer(...args);
    callbackServer.once("close", () => events.push("server-close"));
    return callbackServer;
  });

  const provider = new GmailProvider({
    config: config(),
    credentialStore: new MemoryCredentialStore(),
    async browserOpener() {
      throw new Error("simulated browser launch failure");
    },
  });

  await assert.rejects(
    provider.authorize(
      account,
      { onInstruction: (line) => instructions.push(line), timeoutMs: 100 },
    ),
    { code: "BROWSER_OPEN_FAILED" },
  );
  events.push("authorize-rejected");

  assert.ok(callbackServer);
  assert.equal(callbackServer.listening, false);
  assert.deepEqual(events, ["server-close", "authorize-rejected"]);
  assert.equal(instructions.length, 1);
  assert.doesNotMatch(instructions[0], /https?:\/\//);
});

test("successful authorize resolves only after its keep-alive callback server closes", async (context) => {
  const createServer = http.createServer.bind(http);
  const events = [];
  let callbackServer;
  context.mock.method(http, "createServer", (...args) => {
    callbackServer = createServer(...args);
    callbackServer.once("close", () => events.push("server-close"));
    return callbackServer;
  });
  let tokenRequest;
  context.mock.method(googleAuth.OAuth2.prototype, "getToken", async (request) => {
    tokenRequest = request;
    return {
      tokens: {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expiry_date: Date.now() + 60 * 60_000,
      },
    };
  });
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => ({
    aud: config().providers.google.clientId,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => ({
    data: { emailAddress: "owner@example.com" },
  }));

  const credentialStore = new MemoryCredentialStore();
  const storeCredential = credentialStore.set.bind(credentialStore);
  credentialStore.set = async (...args) => {
    await storeCredential(...args);
    events.push("keychain-set");
  };
  const keepAliveAgent = new http.Agent({ keepAlive: true });
  let callbackRequest;
  let authorization;
  let callbackBody = "";
  const provider = new GmailProvider({
    config: config(),
    credentialStore,
    browserOpener(authorizationUrl) {
      authorization = new URL(authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "test-authorization-code");
      callbackRequest = new Promise((resolve, reject) => {
        const request = http.get(callback, { agent: keepAliveAgent }, (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            callbackBody += chunk;
          });
          response.once("end", () => {
            events.push("callback-end");
            resolve();
          });
        });
        request.once("error", reject);
      });
    },
  });

  try {
    const result = await provider.authorize(
      account,
      { onInstruction: () => {}, timeoutMs: 500 },
    );
    events.push("authorize-resolved");
    await callbackRequest;

    assert.deepEqual(result, {
      alias: "gmail-test",
      email: "owner@example.com",
      provider: "google",
    });
    assert.equal(await credentialStore.has(credentialAccountKey(config(), account)), true);
    assert.equal(authorization.searchParams.get("prompt"), "select_account consent");
    assert.equal(authorization.searchParams.get("login_hint"), account.email);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorization.searchParams.get("code_challenge"));
    assert.equal(authorization.searchParams.has("include_granted_scopes"), false);
    assert.equal(tokenRequest.code, "test-authorization-code");
    assert.ok(tokenRequest.codeVerifier);
    assert.match(callbackBody, /Authorization complete/u);
    assert.match(callbackBody, /stored in macOS Keychain/u);
    assert.equal(callbackServer.listening, false);
    assert.ok(events.indexOf("keychain-set") < events.indexOf("callback-end"));
    assert.ok(events.indexOf("server-close") < events.indexOf("authorize-resolved"));
  } finally {
    keepAliveAgent.destroy();
  }
});

test("Gmail authorize rejects a token issued to another OAuth client before saving", async (context) => {
  const expectedClientId = config().providers.google.clientId;
  const otherClientId = "other-client.apps.googleusercontent.com";
  const credentialStore = new MemoryCredentialStore();
  let callbackRequest;
  let profileCalls = 0;

  context.mock.method(googleAuth.OAuth2.prototype, "getToken", async () => ({
    tokens: {
      access_token: "mismatched-client-access-token",
      refresh_token: "mismatched-client-refresh-token",
      expiry_date: Date.now() + 60 * 60_000,
    },
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => ({
    aud: otherClientId,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => {
    profileCalls += 1;
    return { data: { emailAddress: account.email } };
  });

  const provider = new GmailProvider({
    config: config(),
    credentialStore,
    browserOpener(authorizationUrl) {
      const authorization = new URL(authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "mismatched-client-authorization-code");
      callbackRequest = new Promise((resolve, reject) => {
        const request = http.get(callback, (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", reject);
      });
    },
  });

  await assert.rejects(
    provider.authorize(account, { onInstruction: () => {}, timeoutMs: 500 }),
    (error) => {
      assert.equal(error.code, "GOOGLE_OAUTH_CLIENT_MISMATCH");
      assert.match(error.message, /configured OAuth client/u);
      assert.doesNotMatch(error.message, new RegExp(expectedClientId, "u"));
      assert.doesNotMatch(error.message, new RegExp(otherClientId, "u"));
      return true;
    },
  );
  await callbackRequest;
  assert.equal(profileCalls, 0);
  assert.equal(await credentialStore.get(credentialAccountKey(config(), account)), null);
});

test("failed Gmail Keychain verification restores the previous healthy credential", async (context) => {
  const key = credentialAccountKey(config(), account);
  const previousCredential = JSON.stringify({
    access_token: "previous-access-token",
    refresh_token: "previous-refresh-token",
    expiry_date: Date.now() + 60 * 60_000,
  });
  const credentialStore = new MemoryCredentialStore({ [key]: previousCredential });
  const memoryGet = credentialStore.get.bind(credentialStore);
  const memorySet = credentialStore.set.bind(credentialStore);
  let failNewCredentialReadback = false;
  credentialStore.set = async (storedKey, value) => {
    await memorySet(storedKey, value);
    if (storedKey === key && value !== previousCredential) failNewCredentialReadback = true;
  };
  credentialStore.get = async (storedKey) => {
    if (storedKey === key && failNewCredentialReadback) {
      failNewCredentialReadback = false;
      throw new Error("simulated Keychain readback failure");
    }
    return memoryGet(storedKey);
  };

  context.mock.method(googleAuth.OAuth2.prototype, "getToken", async () => ({
    tokens: {
      access_token: "replacement-access-token",
      refresh_token: "replacement-refresh-token",
      expiry_date: Date.now() + 60 * 60_000,
    },
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "previous-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => ({
    aud: config().providers.google.clientId,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => ({
    data: { emailAddress: account.email },
  }));

  let callbackRequest;
  const provider = new GmailProvider({
    config: config(),
    credentialStore,
    browserOpener(authorizationUrl) {
      const authorization = new URL(authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "replacement-authorization-code");
      callbackRequest = new Promise((resolve, reject) => {
        const request = http.get(callback, (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", reject);
      });
    },
  });

  await assert.rejects(
    provider.authorize(account, { onInstruction: () => {}, timeoutMs: 500 }),
    { code: "KEYCHAIN_WRITE_FAILED" },
  );
  await callbackRequest;
  assert.equal(await credentialStore.get(key), previousCredential);

  const diagnostic = await provider.diagnose(account);
  assert.equal(diagnostic.status, "ok");
  assert.equal(diagnostic.credential_present, true);
  assert.equal(diagnostic.token_valid, true);
  assert.equal(diagnostic.scopes_valid, true);
  assert.equal(diagnostic.identity_verified, true);
});

test("runtime use verifies Gmail identity before migrating a legacy credential", async (context) => {
  const legacyRaw = JSON.stringify({
    access_token: "legacy-access-token",
    refresh_token: "legacy-refresh-token",
    expiry_date: Date.now() + 60 * 60_000,
  });
  const credentialStore = new MemoryCredentialStore({}, {
    legacy: { "google:gmail-test": legacyRaw },
  });
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => ({
    data: { emailAddress: "owner@example.com" },
  }));
  const provider = new GmailProvider({ config: config(), credentialStore });

  await provider.client(account);

  const migrated = await credentialStore.get(credentialAccountKey(config(), account));
  assert.equal(JSON.parse(migrated).refresh_token, "legacy-refresh-token");
  assert.equal(await credentialStore.getLegacy("google:gmail-test"), legacyRaw);
});

test("runtime identity mismatch never migrates a legacy Gmail credential", async (context) => {
  const credentialStore = new MemoryCredentialStore({}, {
    legacy: {
      "google:gmail-test": JSON.stringify({
        access_token: "wrong-access-token",
        refresh_token: "wrong-refresh-token",
        expiry_date: Date.now() + 60 * 60_000,
      }),
    },
  });
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => ({
    data: { emailAddress: "someone-else@example.com" },
  }));
  const provider = new GmailProvider({ config: config(), credentialStore });

  await assert.rejects(provider.client(account), { code: "ACCOUNT_MISMATCH" });
  assert.equal(await credentialStore.get(credentialAccountKey(config(), account)), null);
});

test("runtime Gmail access rejects a mismatched identity even for a profile-bound key", async (context) => {
  const key = credentialAccountKey(config(), account);
  const credentialStore = new MemoryCredentialStore({
    [key]: JSON.stringify({
      access_token: "profile-access-token",
      refresh_token: "profile-refresh-token",
      expiry_date: Date.now() + 60 * 60_000,
    }),
  });
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => ({
    data: { emailAddress: "someone-else@example.com" },
  }));
  const provider = new GmailProvider({ config: config(), credentialStore });

  await assert.rejects(provider.client(account), { code: "ACCOUNT_MISMATCH" });
  assert.equal(await credentialStore.get(key) !== null, true);
});

test("Gmail doctor reports token, scope, and identity without migrating legacy state", async (context) => {
  const legacyRaw = JSON.stringify({
    access_token: "diagnostic-access-token",
    refresh_token: "diagnostic-refresh-token",
  });
  const credentialStore = new MemoryCredentialStore({}, {
    legacy: { "google:gmail-test": legacyRaw },
  });
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => ({
    aud: config().providers.google.clientId,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => ({
    data: { emailAddress: "owner@example.com" },
  }));
  const provider = new GmailProvider({ config: config(), credentialStore });

  const diagnostic = await provider.diagnose(account);

  assert.equal(diagnostic.credential_present, true);
  assert.equal(diagnostic.token_valid, true);
  assert.equal(diagnostic.scopes_valid, true);
  assert.equal(diagnostic.identity_verified, true);
  assert.equal(diagnostic.legacy_migration_pending, true);
  assert.equal(diagnostic.status, "ok");
  assert.equal(await credentialStore.get(credentialAccountKey(config(), account)), null);
});

test("Gmail doctor distinguishes a valid token from missing Gmail scope", async (context) => {
  const key = credentialAccountKey(config(), account);
  const credentialStore = new MemoryCredentialStore({
    [key]: JSON.stringify({ access_token: "identity-only-token" }),
  });
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "identity-only-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => ({
    aud: config().providers.google.clientId,
    scopes: ["openid", "email"],
  }));
  let profileCalls = 0;
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => {
    profileCalls += 1;
    return { data: { emailAddress: "owner@example.com" } };
  });
  const provider = new GmailProvider({ config: config(), credentialStore });

  const diagnostic = await provider.diagnose(account);

  assert.equal(diagnostic.credential_present, true);
  assert.equal(diagnostic.token_valid, true);
  assert.equal(diagnostic.scopes_valid, false);
  assert.equal(diagnostic.identity_verified, null);
  assert.equal(diagnostic.status, "insufficient_scopes");
  assert.equal(profileCalls, 0);
});

test("Gmail doctor requires reauthorization when token audience belongs to another client", async (context) => {
  const expectedClientId = config().providers.google.clientId;
  const otherClientId = "other-client.apps.googleusercontent.com";
  let profileCalls = 0;
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => ({
    aud: otherClientId,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => {
    profileCalls += 1;
    return { data: { emailAddress: account.email } };
  });

  const diagnostic = await new GmailProvider({
    config: config(),
    credentialStore: diagnosticCredentialStore(),
  }).diagnose(account);

  assert.equal(diagnostic.status, "reauthorization_required");
  assert.equal(diagnostic.error_code, "GOOGLE_OAUTH_CLIENT_MISMATCH");
  assert.equal(diagnostic.credential_present, true);
  assert.equal(diagnostic.token_valid, false);
  assert.equal(diagnostic.scopes_valid, null);
  assert.equal(diagnostic.identity_verified, null);
  assert.equal(profileCalls, 0);
  const rendered = JSON.stringify(diagnostic);
  assert.doesNotMatch(rendered, new RegExp(expectedClientId, "u"));
  assert.doesNotMatch(rendered, new RegExp(otherClientId, "u"));
});

function diagnosticCredentialStore() {
  return new MemoryCredentialStore({
    [credentialAccountKey(config(), account)]: JSON.stringify({
      access_token: "diagnostic-access-token",
      refresh_token: "diagnostic-refresh-token",
      expiry_date: Date.now() + 60 * 60_000,
    }),
  });
}

test("Gmail doctor reports a local SDK TypeError as runtime_error", async (context) => {
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => {
    throw new TypeError("simulated bundled SDK failure");
  });
  const diagnostic = await new GmailProvider({
    config: config(),
    credentialStore: diagnosticCredentialStore(),
  }).diagnose(account);

  assert.equal(diagnostic.status, "runtime_error");
  assert.equal(diagnostic.error_code, "OAUTH_RUNTIME_ERROR");
  assert.equal(diagnostic.token_valid, null);
});

test("Gmail doctor reserves reauthorization for explicit invalid_grant", async (context) => {
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => {
    const error = new Error("simulated grant rejection");
    error.response = { status: 400, data: { error: "invalid_grant" } };
    throw error;
  });
  const diagnostic = await new GmailProvider({
    config: config(),
    credentialStore: diagnosticCredentialStore(),
  }).diagnose(account);

  assert.equal(diagnostic.status, "reauthorization_required");
  assert.equal(diagnostic.error_code, "REAUTHENTICATION_REQUIRED");
  assert.equal(diagnostic.token_valid, false);
});

test("Gmail doctor keeps network failures distinct from reauthorization", async (context) => {
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => {
    const error = new Error("simulated network failure");
    error.code = "ENOTFOUND";
    throw error;
  });
  const diagnostic = await new GmailProvider({
    config: config(),
    credentialStore: diagnosticCredentialStore(),
  }).diagnose(account);

  assert.equal(diagnostic.status, "provider_unavailable");
  assert.equal(diagnostic.error_code, "ENOTFOUND");
  assert.equal(diagnostic.token_valid, null);
});

test("Gmail doctor treats HTTP 429 rate limits as provider unavailable", async (context) => {
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => {
    const error = new Error("simulated rate limit");
    error.response = { status: 429, data: { error: "rate_limit_exceeded" } };
    throw error;
  });
  const diagnostic = await new GmailProvider({
    config: config(),
    credentialStore: diagnosticCredentialStore(),
  }).diagnose(account);

  assert.equal(diagnostic.status, "provider_unavailable");
  assert.equal(diagnostic.error_code, "GOOGLE_PROVIDER_UNAVAILABLE");
  assert.equal(diagnostic.token_valid, null);
});

test("Gmail doctor treats a provider rate-limit code as unavailable without HTTP 429", async (context) => {
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => {
    const error = new Error("simulated rate limit code");
    error.response = { status: 400, data: { error: "rate_limit_exceeded" } };
    throw error;
  });
  const diagnostic = await new GmailProvider({
    config: config(),
    credentialStore: diagnosticCredentialStore(),
  }).diagnose(account);

  assert.equal(diagnostic.status, "provider_unavailable");
  assert.equal(diagnostic.error_code, "GOOGLE_PROVIDER_UNAVAILABLE");
  assert.equal(diagnostic.token_valid, null);
});

test("Gmail doctor reports explicit provider policy blocks", async (context) => {
  context.mock.method(googleAuth.OAuth2.prototype, "getAccessToken", async () => ({
    token: "diagnostic-access-token",
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "getTokenInfo", async () => {
    const error = new Error("simulated provider policy");
    error.response = { status: 403, data: { error: "org_internal" } };
    throw error;
  });
  const diagnostic = await new GmailProvider({
    config: config(),
    credentialStore: diagnosticCredentialStore(),
  }).diagnose(account);

  assert.equal(diagnostic.status, "provider_policy_blocked");
  assert.equal(diagnostic.error_code, "OAUTH_PROVIDER_POLICY_BLOCKED");
  assert.equal(diagnostic.token_valid, null);
});
