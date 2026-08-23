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
  context.mock.method(googleAuth.OAuth2.prototype, "getToken", async () => ({
    tokens: {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expiry_date: Date.now() + 60 * 60_000,
    },
  }));
  context.mock.method(googleAuth.OAuth2.prototype, "request", async () => ({
    data: { emailAddress: "owner@example.com" },
  }));

  const credentialStore = new MemoryCredentialStore();
  const keepAliveAgent = new http.Agent({ keepAlive: true });
  let callbackRequest;
  const provider = new GmailProvider({
    config: config(),
    credentialStore,
    browserOpener(authorizationUrl) {
      const authorization = new URL(authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "test-authorization-code");
      callbackRequest = new Promise((resolve, reject) => {
        const request = http.get(callback, { agent: keepAliveAgent }, (response) => {
          response.resume();
          response.once("end", resolve);
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
    assert.equal(callbackServer.listening, false);
    assert.deepEqual(events, ["server-close", "authorize-resolved"]);
  } finally {
    keepAliveAgent.destroy();
  }
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
