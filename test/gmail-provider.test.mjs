import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { buildRawMessage } from "../src/mime.mjs";
import { runWithOperationDeadline } from "../src/operation-deadline.mjs";
import { GmailProvider } from "../src/providers/gmail.mjs";
import {
  EFFECTIVE_SEND_MANIFEST_VERSION,
  EFFECTIVE_SEND_POLICY_VERSION,
} from "../src/send-approval.mjs";

const account = {
  alias: "gmail",
  email: "owner@example.com",
  provider: "google",
};

function expectedRequestOptions() {
  return {
    timeout: 90_000,
    maxContentLength: 4 * 1024 * 1024,
    size: 4 * 1024 * 1024,
    retry: false,
    retryConfig: { retry: 0 },
    maxRedirects: 0,
    follow: 0,
    redirect: "error",
    // Provider harnesses structured-clone request options before comparing.
    signal: {},
  };
}

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function plainPayload({ body = "Hello, world.", bodyPart, headers = [], ...overrides } = {}) {
  const bodyBytes = Buffer.from(body, "utf8");
  return {
    mimeType: "text/plain",
    filename: "",
    headers: [
      { name: "From", value: "Owner <OWNER@Example.COM>" },
      { name: "To", value: "Recipient <Recipient@Example.COM>" },
      { name: "Subject", value: "Status" },
      { name: "Content-Type", value: 'text/plain; charset="UTF-8"' },
      ...headers,
    ],
    body: bodyPart ?? {
      size: bodyBytes.length,
      data: bodyBytes.toString("base64url"),
    },
    ...overrides,
  };
}

function fullDraft({
  draftId = "draft-1",
  messageId = "message-1",
  threadId = "thread-1",
  payload = plainPayload(),
} = {}) {
  return {
    id: draftId,
    message: {
      id: messageId,
      threadId,
      payload,
    },
  };
}

function rawDraft({
  draftId = "draft-1",
  messageId = "message-1",
  threadId = "thread-1",
  raw = encode("From: owner@example.com\r\n\r\nHello, world.\r\n"),
} = {}) {
  return {
    id: draftId,
    message: {
      id: messageId,
      threadId,
      raw,
    },
  };
}

function approvedManifest(review, overrides = {}) {
  const body = overrides.body ?? review.body;
  const manifest = {
    manifestVersion: EFFECTIVE_SEND_MANIFEST_VERSION,
    policyVersion: EFFECTIVE_SEND_POLICY_VERSION,
    account: account.alias,
    provider: "google",
    authenticatedPrincipal: account.email,
    mailboxResource: account.email,
    draftId: review.draftId,
    messageId: review.messageId,
    threadId: review.threadId,
    from: review.from,
    sender: review.sender,
    replyTo: review.replyTo,
    to: review.to,
    cc: review.cc,
    bcc: review.bcc,
    subject: review.subject,
    body,
    inReplyTo: review.inReplyTo,
    references: review.references,
    bodyFormat: "text",
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    attachments: [],
    completeness: "complete",
    providerRevision: {
      messageId: review.messageId,
      threadId: review.threadId,
      rawPayloadSha256: review.rawPayloadSha256,
      changeKey: null,
      lastModifiedDateTime: null,
    },
  };
  return {
    ...manifest,
    ...overrides,
    providerRevision: {
      ...manifest.providerRevision,
      ...(overrides.providerRevision || {}),
    },
  };
}

function harness({
  full = fullDraft(),
  raw = rawDraft(),
  rawSequence = null,
  beforeSend = null,
  sendError = null,
} = {}) {
  const calls = {
    get: [],
    getOptions: [],
    send: 0,
    sendOptions: [],
    sendRequests: [],
  };
  let currentFull = structuredClone(full);
  let currentRaw = structuredClone(raw);
  let currentGetError = null;
  let queuedRaw = rawSequence?.map((value) => structuredClone(value)) || null;
  let rawIndex = 0;
  const gmail = {
    users: {
      drafts: {
        async get(request, options) {
          calls.get.push(structuredClone(request));
          calls.getOptions.push(structuredClone(options));
          if (currentGetError) throw currentGetError;
          assert.equal(request.userId, "me");
          assert.equal(request.id, "draft-1");
          if (request.format === "full") return { data: structuredClone(currentFull) };
          if (request.format === "raw") {
            const value = queuedRaw
              ? queuedRaw[Math.min(rawIndex++, queuedRaw.length - 1)]
              : currentRaw;
            return { data: structuredClone(value) };
          }
          throw new Error(`Unexpected Gmail draft format: ${request.format}`);
        },
        async send(request, options) {
          if (beforeSend) {
            await beforeSend({
              setFull(value) {
                currentFull = structuredClone(value);
              },
              setRaw(value) {
                currentRaw = structuredClone(value);
                queuedRaw = null;
                rawIndex = 0;
              },
            });
          }
          calls.send += 1;
          calls.sendOptions.push(structuredClone(options));
          calls.sendRequests.push(structuredClone(request));
          if (sendError) throw sendError;
          return { data: { id: "sent-1", threadId: "thread-1" } };
        },
      },
    },
  };
  const mail = new GmailProvider({
    config: { providers: { google: {} } },
    credentialStore: {},
  });
  mail.client = async () => gmail;
  return {
    calls,
    mail,
    setFull(value) {
      currentFull = structuredClone(value);
    },
    setRaw(value) {
      currentRaw = structuredClone(value);
      queuedRaw = null;
      rawIndex = 0;
    },
    setGetError(error) {
      currentGetError = error;
    },
  };
}

test("Google OAuth transport applies and safely classifies its request deadline", async () => {
  const mail = new GmailProvider({
    config: {
      profileId: "test-profile",
      providers: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
    credentialStore: {
      async get() {
        return JSON.stringify({
          refresh_token: "stored-refresh-token",
          expiry_date: 0,
        });
      },
    },
  });
  const session = await mail.oauthSession(account, {
    persistUpdates: false,
    allowLegacy: false,
  });
  assert.equal(session.oauth.transporter.defaults.timeout, 90_000);
  assert.equal(session.oauth.transporter.defaults.maxContentLength, 4 * 1024 * 1024);
  assert.equal(session.oauth.transporter.defaults.size, 4 * 1024 * 1024);
  assert.equal(session.oauth.transporter.defaults.retry, false);
  assert.equal(session.oauth.transporter.defaults.retryConfig.retry, 0);
  assert.equal(session.oauth.transporter.defaults.maxRedirects, 0);
  assert.equal(session.oauth.transporter.defaults.follow, 0);
  assert.equal(session.oauth.transporter.defaults.redirect, "error");

  const attempts = [];
  session.oauth.transporter.defaults.adapter = async (options) => {
    const url = new URL(options.url);
    attempts.push({
      pathname: url.pathname,
      timeout: options.timeout,
      maxContentLength: options.maxContentLength,
      size: options.size,
      retry: options.retry,
      retries: options.retryConfig?.retry,
      maxRedirects: options.maxRedirects,
      follow: options.follow,
      redirect: options.redirect,
    });
    throw Object.assign(new Error("sensitive-token-material-must-not-escape"), {
      code: "TimeoutError",
    });
  };

  const assertTimedOutSafely = async (operation, expectedPath) => {
    const start = attempts.length;
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, "GOOGLE_REQUEST_TIMEOUT");
      assert.equal(error.message, "The Google request timed out before completing.");
      assert.doesNotMatch(String(error), /sensitive-token-material/u);
      return true;
    });
    const operationAttempts = attempts.slice(start);
    assert.deepEqual(operationAttempts, [
      {
        pathname: expectedPath,
        timeout: 90_000,
        maxContentLength: 4 * 1024 * 1024,
        size: 4 * 1024 * 1024,
        retry: false,
        retries: 0,
        maxRedirects: 0,
        follow: 0,
        redirect: "error",
      },
    ]);
  };

  await assertTimedOutSafely(() => session.oauth.getAccessToken(), "/token");
  await assertTimedOutSafely(
    () => session.oauth.getTokenInfo("sensitive-access-token"),
    "/tokeninfo",
  );
  await assertTimedOutSafely(
    () => session.oauth.revokeToken("sensitive-access-token"),
    "/revoke",
  );

  session.oauth.setCredentials({
    access_token: "sensitive-access-token",
    expiry_date: Date.now() + 10 * 60_000,
  });
  mail.oauthSession = async () => session;
  await assertTimedOutSafely(
    () => mail.client(account),
    "/gmail/v1/users/me/profile",
  );
});

test("Google request timeout remains enforceable inside the shared operation deadline", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("stalled");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const mail = new GmailProvider({
    config: {
      profileId: "test-profile",
      providers: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
    credentialStore: {
      async get() {
        return JSON.stringify({
          access_token: "test-access-token",
          expiry_date: Date.now() + 10 * 60_000,
        });
      },
    },
  });
  const session = await mail.oauthSession(account, {
    persistUpdates: false,
    allowLegacy: false,
  });
  const startedAt = Date.now();

  try {
    await assert.rejects(
      runWithOperationDeadline(
        () =>
          session.oauth.transporter.request({
            url: `http://127.0.0.1:${server.address().port}/stalled`,
            responseType: "text",
            noProxy: ["127.0.0.1"],
          }),
        { timeoutMs: 400 },
      ),
      { code: "GOOGLE_REQUEST_TIMEOUT" },
    );
    assert.ok(Date.now() - startedAt < 350);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Gmail diagnostics redact a provider-controlled error code", async () => {
  const maliciousCode = "PROVIDER_CODE\n/Users/private/oauth-token-must-not-leak";
  const mail = new GmailProvider({
    config: {
      profileId: "test-profile",
      providers: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
    credentialStore: {
      async get() {
        return JSON.stringify({
          access_token: "test-access-token",
          expiry_date: Date.now() + 10 * 60_000,
        });
      },
    },
  });
  const session = await mail.oauthSession(account, {
    persistUpdates: false,
    allowLegacy: false,
  });
  session.oauth.transporter.defaults.adapter = async (options) => {
    const path = new URL(options.url).pathname;
    if (path === "/tokeninfo") {
      return {
        config: options,
        data: {
          aud: "test-client-id",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        },
        headers: new Headers(),
        status: 200,
        statusText: "OK",
      };
    }
    return {
      config: options,
      data: { error: { code: maliciousCode, message: "must-not-leak" } },
      headers: new Headers(),
      status: 500,
      statusText: "Provider error",
    };
  };
  mail.oauthSession = async () => session;

  const diagnostic = await mail.diagnose(account);

  assert.equal(diagnostic.status, "provider_unavailable");
  assert.equal(diagnostic.error_code, "GOOGLE_PROFILE_FAILED");
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|oauth-token|PROVIDER_CODE/u);
});

test("Google transport rejects an oversized local response before exposing its body", async () => {
  const sensitiveMarker = "sensitive-response-body-must-not-escape";
  const oversized = `${"x".repeat(4 * 1024 * 1024)}${sensitiveMarker}`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(oversized);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const mail = new GmailProvider({
    config: {
      profileId: "test-profile",
      providers: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
    credentialStore: {
      async get() {
        return JSON.stringify({
          access_token: "test-access-token",
          expiry_date: Date.now() + 10 * 60_000,
        });
      },
    },
  });
  const session = await mail.oauthSession(account, {
    persistUpdates: false,
    allowLegacy: false,
  });

  try {
    await assert.rejects(
      session.oauth.transporter.request({
        url: `http://127.0.0.1:${server.address().port}/oversized`,
        responseType: "text",
        noProxy: ["127.0.0.1"],
      }),
      (error) => {
        assert.equal(error.code, "GOOGLE_RESPONSE_TOO_LARGE");
        assert.equal(
          error.message,
          "The Google response exceeded the safe transport limit.",
        );
        assert.doesNotMatch(String(error), new RegExp(sensitiveMarker, "u"));
        assert.doesNotMatch(String(error), /127\.0\.0\.1/u);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Google transport closes a stalled oversized response after Content-Length rejection", async () => {
  let responseClosed = false;
  let socketDestroyed = false;
  let settleClosed;
  const closed = new Promise((resolve) => {
    settleClosed = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.on("close", () => {
      responseClosed = true;
      socketDestroyed = response.socket?.destroyed ?? true;
      settleClosed();
    });
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(5 * 1024 * 1024),
    });
    response.write("x".repeat(1024));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const mail = new GmailProvider({
    config: {
      profileId: "test-profile",
      providers: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
    credentialStore: {
      async get() {
        return JSON.stringify({
          access_token: "test-access-token",
          expiry_date: Date.now() + 10 * 60_000,
        });
      },
    },
  });
  const session = await mail.oauthSession(account, {
    persistUpdates: false,
    allowLegacy: false,
  });

  try {
    await assert.rejects(
      session.oauth.transporter.request({
        url: `http://127.0.0.1:${server.address().port}/stalled`,
        responseType: "text",
        noProxy: ["127.0.0.1"],
      }),
      { code: "GOOGLE_RESPONSE_TOO_LARGE" },
    );
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("oversized response stayed open")), 1_000),
      ),
    ]);
    assert.equal(responseClosed, true);
    assert.equal(socketDestroyed, true);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Google transport rejects 307 redirects without replaying a POST body", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (request.url === "/first") {
        response.writeHead(307, { location: "/second" });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const mail = new GmailProvider({
    config: {
      profileId: "test-profile",
      providers: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
    credentialStore: {
      async get() {
        return JSON.stringify({
          access_token: "test-access-token",
          expiry_date: Date.now() + 10 * 60_000,
        });
      },
    },
  });
  const session = await mail.oauthSession(account, {
    persistUpdates: false,
    allowLegacy: false,
  });

  try {
    await assert.rejects(
      session.oauth.transporter.request({
        url: `http://127.0.0.1:${server.address().port}/first`,
        method: "POST",
        data: "frozen-mime-body",
        noProxy: ["127.0.0.1"],
      }),
      { code: "GOOGLE_NETWORK_ERROR" },
    );
    assert.deepEqual(requests, [
      { method: "POST", path: "/first", body: "frozen-mime-body" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Gmail profile and runtime CRUD requests carry the provider deadline", async () => {
  const calls = [];
  const record = (operation, response) => async (_request, options) => {
    calls.push({ operation, options: structuredClone(options) });
    return { data: structuredClone(response) };
  };
  const message = {
    id: "message-1",
    threadId: "thread-1",
    snippet: "Hello",
    labelIds: ["INBOX"],
    payload: plainPayload({ body: "Hello" }),
  };
  const gmail = {
    users: {
      getProfile: record("profile.get", {
        emailAddress: account.email,
        messagesTotal: 1,
        threadsTotal: 1,
      }),
      messages: {
        list: record("messages.list", {
          messages: [{ id: message.id }],
          resultSizeEstimate: 1,
        }),
        get: record("messages.get", message),
        batchModify: record("messages.batchModify", {}),
      },
      drafts: {
        create: record("drafts.create", {
          id: "draft-1",
          message: { id: message.id, threadId: message.threadId },
        }),
        get: record("drafts.get", { id: "draft-1", message }),
        update: record("drafts.update", {
          id: "draft-1",
          message: { id: message.id, threadId: message.threadId },
        }),
      },
      labels: {
        list: record("labels.list", { labels: [] }),
      },
    },
  };
  const mail = new GmailProvider({
    config: { providers: { google: {} } },
    credentialStore: {},
  });
  mail.client = async () => gmail;

  await mail.profile(account);
  await mail.search(account, { query: "is:unread", maxResults: 1 });
  await mail.getMessage(account, message.id);
  await mail.createDraft(account, {
    to: ["recipient@example.com"],
    subject: "Status",
    body: "Hello",
  });
  await mail.updateDraft(account, "draft-1", { body: "Updated" });
  await mail.archive(account, [message.id]);
  await mail.markRead(account, [message.id], true);
  await mail.listLabels(account);
  await mail.modifyLabels(account, [message.id], { addLabelIds: ["STARRED"] });

  assert.deepEqual(
    new Set(calls.map(({ operation }) => operation)),
    new Set([
      "profile.get",
      "messages.list",
      "messages.get",
      "messages.batchModify",
      "drafts.create",
      "drafts.get",
      "drafts.update",
      "labels.list",
    ]),
  );
  assert.ok(calls.length >= 11);
  for (const { options } of calls) {
    assert.deepEqual(options, expectedRequestOptions());
  }
});

test("Gmail requests use the remaining shared MCP operation budget", async () => {
  let requestOptions;
  const mail = new GmailProvider({
    config: { providers: { google: {} } },
    credentialStore: {},
  });
  mail.client = async () => ({
    users: {
      async getProfile(_request, options) {
        requestOptions = options;
        return { data: { emailAddress: account.email } };
      },
    },
  });

  await runWithOperationDeadline(() => mail.profile(account), { timeoutMs: 1_000 });
  assert.ok(requestOptions.timeout > 0 && requestOptions.timeout <= 750);
  assert.equal(requestOptions.maxContentLength, 4 * 1024 * 1024);
  assert.equal(requestOptions.size, 4 * 1024 * 1024);
  assert.equal(requestOptions.retry, false);
  assert.equal(requestOptions.retryConfig.retry, 0);
  assert.equal(requestOptions.maxRedirects, 0);
  assert.equal(requestOptions.follow, 0);
  assert.equal(requestOptions.redirect, "error");
  assert.equal(requestOptions.signal instanceof AbortSignal, true);
});

test("reviewDraft returns a complete identity-bound plain-text manifest", async () => {
  const body = "Hello, 世界.";
  const rawMessage = "From: owner@example.com\r\nTo: recipient@example.com\r\n\r\nHello, world.\r\n";
  const { calls, mail } = harness({
    full: fullDraft({
      payload: plainPayload({
        body,
        headers: [
          { name: "Cc", value: "Copy@Example.COM" },
          { name: "Bcc", value: "Audit@Example.COM" },
        ],
      }),
    }),
    raw: rawDraft({ raw: encode(rawMessage) }),
  });

  const review = await mail.reviewDraft(account, "draft-1");

  assert.deepEqual(calls.get, [
    { userId: "me", id: "draft-1", format: "raw" },
    { userId: "me", id: "draft-1", format: "full" },
    { userId: "me", id: "draft-1", format: "raw" },
  ]);
  assert.deepEqual(calls.getOptions, [
    expectedRequestOptions(),
    expectedRequestOptions(),
    expectedRequestOptions(),
  ]);
  assert.deepEqual(review, {
    account: "gmail",
    draftId: "draft-1",
    messageId: "message-1",
    threadId: "thread-1",
    from: "owner@example.com",
    sender: "owner@example.com",
    replyTo: [],
    to: ["recipient@example.com"],
    cc: ["copy@example.com"],
    bcc: ["audit@example.com"],
      subject: "Status",
      body,
      inReplyTo: "",
      references: "",
      bodyFormat: "text",
    attachments: [],
    completeness: "complete",
    truncated: false,
    rawPayloadSha256: createHash("sha256")
      .update(Buffer.from(rawMessage, "utf8"))
      .digest("hex"),
  });
});

test("reviewDraft accepts display names but rejects non-canonical recipient syntax", async () => {
  const displayPayload = plainPayload();
  displayPayload.headers.find((header) => header.name === "To").value =
    '"Recipient, One" <Recipient@Example.COM>';
  const { mail: displayMail } = harness({
    full: fullDraft({ payload: displayPayload }),
  });
  assert.deepEqual((await displayMail.reviewDraft(account, "draft-1")).to, [
    "recipient@example.com",
  ]);

  for (const value of [
    "victim:attacker@example.com",
    "victim:<attacker@example.com>",
    "good@example.com, malformed",
    "owner\0@example.com",
    "Owner\0 <owner@example.com>",
  ]) {
    const payload = plainPayload();
    payload.headers.find((header) => header.name === "To").value = value;
    const { mail } = harness({ full: fullDraft({ payload }) });
    await assert.rejects(mail.reviewDraft(account, "draft-1"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
  }
});

test("reviewDraft decodes Subject and binds reply-thread headers explicitly", async () => {
  const payload = plainPayload({
    headers: [
      { name: "In-Reply-To", value: "  <parent@example.com>  " },
      {
        name: "References",
        value: "<root@example.com>\t <parent@example.com>",
      },
    ],
  });
  payload.headers.find((header) => header.name === "Subject").value =
    "=?UTF-8?B?5L2g5aW9?=";
  const { mail } = harness({
    full: fullDraft({ payload }),
  });

  const review = await mail.reviewDraft(account, "draft-1");

  assert.equal(review.subject, "你好");
  assert.equal(review.inReplyTo, "<parent@example.com>");
  assert.equal(review.references, "<root@example.com> <parent@example.com>");
});

test("reviewDraft rejects ambiguous, multiline, and oversized reply-thread headers", async (context) => {
  const cases = [
    {
      name: "duplicate In-Reply-To",
      headers: [
        { name: "In-Reply-To", value: "<one@example.com>" },
        { name: "In-Reply-To", value: "<two@example.com>" },
      ],
    },
    {
      name: "multiline References",
      headers: [{ name: "References", value: "<one@example.com>\r\nBcc: hidden@example.net" }],
    },
    {
      name: "oversized In-Reply-To",
      headers: [{ name: "In-Reply-To", value: "x".repeat(901) }],
    },
    {
      name: "oversized References",
      headers: [{ name: "References", value: "<x> ".repeat(2049) }],
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const { mail } = harness({
        full: fullDraft({ payload: plainPayload({ headers: item.headers }) }),
      });
      await assert.rejects(mail.reviewDraft(account, "draft-1"), {
        code: "DRAFT_NOT_REVIEWABLE",
      });
    });
  }
});

test("reviewDraft rejects HTML and unknown MIME payloads", async (context) => {
  for (const mimeType of ["text/html", "application/octet-stream", ""]) {
    await context.test(mimeType || "missing MIME type", async () => {
      const body = mimeType === "text/html" ? "<strong>Hello</strong>" : "unknown";
      const { mail } = harness({
        full: fullDraft({ payload: plainPayload({ body, mimeType }) }),
      });
      await assert.rejects(mail.reviewDraft(account, "draft-1"), {
        code: "DRAFT_NOT_REVIEWABLE",
      });
    });
  }
});

test("reviewDraft rejects attachments, inline content, and nested MIME", async (context) => {
  const cases = [
    {
      name: "attachment metadata",
      payload: plainPayload({
        filename: "invoice.pdf",
        bodyPart: { size: 0, attachmentId: "attachment-1" },
      }),
    },
    {
      name: "inline disposition",
      payload: plainPayload({
        headers: [{ name: "Content-Disposition", value: "inline" }],
      }),
    },
    {
      name: "inline content ID",
      payload: plainPayload({
        headers: [{ name: "Content-ID", value: "<image-1>" }],
      }),
    },
    {
      name: "multipart nesting",
      payload: {
        mimeType: "multipart/alternative",
        filename: "",
        headers: plainPayload().headers,
        body: { size: 0 },
        parts: [plainPayload()],
      },
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const { mail } = harness({ full: fullDraft({ payload: item.payload }) });
      await assert.rejects(mail.reviewDraft(account, "draft-1"), {
        code: "DRAFT_NOT_REVIEWABLE",
      });
    });
  }
});

test("reviewDraft rejects ambiguous or non-primary sending identities", async (context) => {
  const cases = [
    {
      name: "wrong From",
      headers: [{ name: "From", value: "attacker@example.net" }],
    },
    {
      name: "duplicate From",
      headers: [{ name: "From", value: "owner@example.com" }],
    },
    {
      name: "wrong Sender",
      headers: [{ name: "Sender", value: "delegate@example.net" }],
    },
    {
      name: "same-account Reply-To is still unsupported",
      headers: [{ name: "Reply-To", value: "owner@example.com" }],
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const payload = plainPayload({ headers: item.headers });
      if (item.name === "wrong From") {
        payload.headers = payload.headers.filter(
          (header, index) => header.name !== "From" || index !== 0,
        );
      }
      const { mail } = harness({ full: fullDraft({ payload }) });
      await assert.rejects(mail.reviewDraft(account, "draft-1"), {
        code: "DRAFT_NOT_REVIEWABLE",
      });
    });
  }
});

test("reviewDraft rejects missing raw data and full/raw identity races", async (context) => {
  await context.test("missing raw payload", async () => {
    const value = rawDraft();
    delete value.message.raw;
    const { mail } = harness({ raw: value });
    await assert.rejects(mail.reviewDraft(account, "draft-1"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
  });

  await context.test("raw payload over 2 MB", async () => {
    const { mail } = harness({
      raw: rawDraft({ raw: encode("x".repeat(2 * 1024 * 1024 + 1)) }),
    });
    await assert.rejects(mail.reviewDraft(account, "draft-1"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
  });

  for (const mismatch of [
    { messageId: "message-2" },
    { threadId: "thread-2" },
    { draftId: "draft-2" },
  ]) {
    await context.test(`identity mismatch ${JSON.stringify(mismatch)}`, async () => {
      const { mail } = harness({ raw: rawDraft(mismatch) });
      await assert.rejects(mail.reviewDraft(account, "draft-1"), {
        code: "DRAFT_NOT_REVIEWABLE",
      });
    });
  }

  await context.test("raw revision changes around the full snapshot", async () => {
    const { mail } = harness({
      rawSequence: [
        rawDraft(),
        rawDraft({ raw: encode("From: owner@example.com\r\n\r\nChanged.\r\n") }),
      ],
    });
    await assert.rejects(mail.reviewDraft(account, "draft-1"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
  });
});

test("reviewDraft rejects headers that can alter effective sending semantics", async () => {
  const { mail } = harness({
    full: fullDraft({
      payload: plainPayload({
        headers: [{ name: "Resent-To", value: "hidden@example.net" }],
      }),
    }),
  });

  await assert.rejects(mail.reviewDraft(account, "draft-1"), {
    code: "DRAFT_NOT_REVIEWABLE",
  });
});

test("reviewDraft rejects incomplete and oversized bodies", async (context) => {
  await context.test("non-empty body without inline data", async () => {
    const { mail } = harness({
      full: fullDraft({
        payload: plainPayload({ bodyPart: { size: 8 } }),
      }),
    });
    await assert.rejects(mail.reviewDraft(account, "draft-1"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
  });

  await context.test("body over 1 MB", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    const { mail } = harness({
      full: fullDraft({ payload: plainPayload({ body: oversized }) }),
    });
    await assert.rejects(mail.reviewDraft(account, "draft-1"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
  });
});

test("sendDraft performs a final raw revision check and refuses a changed draft", async () => {
  const { calls, mail, setRaw } = harness();
  const review = await mail.reviewDraft(account, "draft-1");
  setRaw(rawDraft({ raw: encode("From: owner@example.com\r\n\r\nChanged.\r\n") }));

  await assert.rejects(
    mail.sendDraft(account, "draft-1", approvedManifest(review)),
    { code: "DRAFT_CHANGED" },
  );
  assert.equal(calls.send, 0);
});

test("sendDraft checks every Gmail revision field before sending", async (context) => {
  for (const changed of [
    { messageId: "message-2" },
    { threadId: "thread-2" },
    { rawPayloadSha256: "0".repeat(64) },
  ]) {
    await context.test(Object.keys(changed)[0], async () => {
      const { calls, mail } = harness();
      const review = await mail.reviewDraft(account, "draft-1");
      await assert.rejects(
        mail.sendDraft(
          account,
          "draft-1",
          approvedManifest(review, { providerRevision: changed }),
        ),
        { code: "DRAFT_CHANGED" },
      );
      assert.equal(calls.send, 0);
    });
  }
});

test("sendDraft sends once when the expected raw revision still matches", async () => {
  const { calls, mail } = harness();
  const review = await mail.reviewDraft(account, "draft-1");

  const manifest = approvedManifest(review);
  const sent = await mail.sendDraft(account, "draft-1", manifest);

  assert.equal(calls.send, 1);
  assert.equal(calls.get.at(-1).format, "raw");
  assert.deepEqual(calls.sendOptions, [expectedRequestOptions()]);
  assert.deepEqual(calls.sendRequests, [
    {
      userId: "me",
      requestBody: {
        id: "draft-1",
        message: {
          raw: buildRawMessage({
            from: manifest.from,
            to: manifest.to,
            cc: manifest.cc,
            bcc: manifest.bcc,
            subject: manifest.subject,
            body: manifest.body,
          }),
          threadId: "thread-1",
        },
      },
    },
  ]);
  assert.deepEqual(sent, {
    account: "gmail",
    provider: "google",
    sentMessageId: "sent-1",
    threadId: "thread-1",
    status: "sent",
  });
});

test("sendDraft does not retry a safely classified provider timeout", async () => {
  const timeout = Object.assign(
    new Error("The Google request timed out before completing."),
    { code: "GOOGLE_REQUEST_TIMEOUT" },
  );
  const { calls, mail } = harness({ sendError: timeout });
  const review = await mail.reviewDraft(account, "draft-1");

  await assert.rejects(
    mail.sendDraft(account, "draft-1", approvedManifest(review)),
    {
      code: "GOOGLE_REQUEST_TIMEOUT",
      message: "The Google request timed out before completing.",
    },
  );
  assert.equal(calls.send, 1);
  assert.deepEqual(calls.sendOptions, [expectedRequestOptions()]);
});

test("the real Gmail POST send adapter is attempted exactly once on TimeoutError", async () => {
  const reviewedHarness = harness();
  const review = await reviewedHarness.mail.reviewDraft(account, "draft-1");
  const mail = new GmailProvider({
    config: {
      profileId: "test-profile",
      providers: {
        google: {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
    },
    credentialStore: {
      async get() {
        return JSON.stringify({
          access_token: "sensitive-access-token",
          expiry_date: Date.now() + 10 * 60_000,
        });
      },
    },
  });
  const session = await mail.oauthSession(account, {
    persistUpdates: false,
    allowLegacy: false,
  });
  mail.oauthSession = async () => session;
  mail.verifiedAliases.add(account.alias);

  const attempts = [];
  session.oauth.transporter.defaults.adapter = async (options) => {
    const url = new URL(options.url);
    attempts.push({
      method: options.method,
      pathname: url.pathname,
      timeout: options.timeout,
      maxContentLength: options.maxContentLength,
      size: options.size,
      retry: options.retry,
      retries: options.retryConfig?.retry,
    });
    if (url.pathname.endsWith("/drafts/draft-1")) {
      return {
        config: options,
        data: rawDraft(),
        headers: new Headers(),
        status: 200,
        statusText: "OK",
      };
    }
    throw Object.assign(new Error("sensitive-send-timeout"), {
      code: "TimeoutError",
    });
  };

  await assert.rejects(
    mail.sendDraft(account, "draft-1", approvedManifest(review)),
    {
      code: "GOOGLE_REQUEST_TIMEOUT",
      message: "The Google request timed out before completing.",
    },
  );
  assert.equal(
    attempts.filter(({ pathname }) => pathname.endsWith("/drafts/send")).length,
    1,
  );
  assert.ok(
    attempts.every(
      ({ timeout, maxContentLength, size, retry, retries }) =>
        timeout === 90_000 &&
        maxContentLength === 4 * 1024 * 1024 &&
        size === 4 * 1024 * 1024 &&
        retry === false &&
        retries === 0,
    ),
  );
});

test("legacy credentials refresh before Gmail POST and never replay 401 or 403 mutations", async (context) => {
  const reviewedHarness = harness();
  const review = await reviewedHarness.mail.reviewDraft(account, "draft-1");

  for (const status of [401, 403]) {
    await context.test(`send ${status}`, async () => {
      const mail = new GmailProvider({
        config: {
          profileId: "test-profile",
          providers: {
            google: {
              clientId: "test-client-id",
              clientSecret: "test-client-secret",
            },
          },
        },
        credentialStore: {
          async get() {
            return JSON.stringify({
              access_token: "stale-access-token",
              refresh_token: "stored-refresh-token",
            });
          },
          async set() {},
        },
      });
      const session = await mail.oauthSession(account, {
        persistUpdates: false,
        allowLegacy: false,
      });
      mail.oauthSession = async () => session;
      mail.verifiedAliases.add(account.alias);

      const attempts = [];
      session.oauth.transporter.defaults.adapter = async (options) => {
        const url = new URL(options.url);
        attempts.push({
          method: options.method,
          pathname: url.pathname,
          authorization: options.headers?.get?.("authorization"),
        });
        if (url.pathname === "/token") {
          return {
            config: options,
            data: {
              access_token: "fresh-access-token",
              expires_in: 3_600,
              token_type: "Bearer",
            },
            headers: new Headers(),
            status: 200,
            statusText: "OK",
          };
        }
        if (url.pathname.endsWith("/drafts/draft-1")) {
          return {
            config: options,
            data: rawDraft(),
            headers: new Headers(),
            status: 200,
            statusText: "OK",
          };
        }
        return {
          config: options,
          data: { error: { code: status, message: "simulated auth failure" } },
          headers: new Headers(),
          status,
          statusText: "Auth failure",
        };
      };

      await assert.rejects(
        mail.sendDraft(account, "draft-1", approvedManifest(review)),
        (error) => error?.response?.status === status,
      );
      const tokenIndex = attempts.findIndex(({ pathname }) => pathname === "/token");
      assert.equal(
        attempts.filter(({ pathname }) => pathname === "/token").length,
        1,
      );
      const sendAttempts = attempts.filter(({ pathname }) =>
        pathname.endsWith("/drafts/send"),
      );
      const sendIndex = attempts.findIndex(({ pathname }) => pathname.endsWith("/drafts/send"));
      assert.ok(tokenIndex >= 0 && tokenIndex < sendIndex);
      assert.deepEqual(sendAttempts, [
        {
          method: "POST",
          pathname: "/gmail/v1/users/me/drafts/send",
          authorization: "Bearer fresh-access-token",
        },
      ]);
      assert.ok(Number.isSafeInteger(session.oauth.credentials.expiry_date));
    });

    await context.test(`archive ${status}`, async () => {
      const mail = new GmailProvider({
        config: {
          profileId: "test-profile",
          providers: {
            google: {
              clientId: "test-client-id",
              clientSecret: "test-client-secret",
            },
          },
        },
        credentialStore: {
          async get() {
            return JSON.stringify({
              access_token: "stale-access-token",
              refresh_token: "stored-refresh-token",
            });
          },
          async set() {},
        },
      });
      const session = await mail.oauthSession(account, {
        persistUpdates: false,
        allowLegacy: false,
      });
      mail.oauthSession = async () => session;
      mail.verifiedAliases.add(account.alias);

      const attempts = [];
      session.oauth.transporter.defaults.adapter = async (options) => {
        const url = new URL(options.url);
        attempts.push({ method: options.method, pathname: url.pathname });
        if (url.pathname === "/token") {
          return {
            config: options,
            data: {
              access_token: "fresh-access-token",
              expires_in: 3_600,
              token_type: "Bearer",
            },
            headers: new Headers(),
            status: 200,
            statusText: "OK",
          };
        }
        return {
          config: options,
          data: { error: { code: status, message: "simulated auth failure" } },
          headers: new Headers(),
          status,
          statusText: "Auth failure",
        };
      };

      await assert.rejects(
        mail.archive(account, ["message-1"]),
        (error) => error?.response?.status === status,
      );
      assert.equal(attempts[0].pathname, "/token");
      assert.equal(
        attempts.filter(({ pathname }) => pathname === "/token").length,
        1,
      );
      assert.deepEqual(
        attempts.filter(({ pathname }) => pathname.endsWith("/messages/batchModify")),
        [
          {
            method: "POST",
            pathname: "/gmail/v1/users/me/messages/batchModify",
          },
        ],
      );
    });
  }
});

test("sendDraft reports client failure before dispatch as definitely unsent", async () => {
  const { calls, mail } = harness();
  const review = await mail.reviewDraft(account, "draft-1");
  mail.client = async () => {
    throw Object.assign(new Error("simulated token timeout"), {
      code: "GOOGLE_REQUEST_TIMEOUT",
    });
  };

  await assert.rejects(
    mail.sendDraft(account, "draft-1", approvedManifest(review)),
    {
      code: "SEND_VERIFICATION_FAILED",
      message: "The Gmail draft could not be verified before sending. Nothing was sent.",
    },
  );
  assert.equal(calls.send, 0);
});

test("sendDraft reports a preflight timeout as a definite verification failure", async () => {
  const { calls, mail, setGetError } = harness();
  const review = await mail.reviewDraft(account, "draft-1");
  setGetError(
    Object.assign(new Error("The Google request timed out before completing."), {
      code: "GOOGLE_REQUEST_TIMEOUT",
    }),
  );

  await assert.rejects(
    mail.sendDraft(account, "draft-1", approvedManifest(review)),
    {
      code: "SEND_VERIFICATION_FAILED",
      message: "The Gmail draft could not be verified before sending. Nothing was sent.",
    },
  );
  assert.equal(calls.send, 0);
});

test("an exhausted operation deadline does not start the Gmail send request", async () => {
  const { calls, mail } = harness();
  const review = await mail.reviewDraft(account, "draft-1");

  await assert.rejects(
    runWithOperationDeadline(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return mail.sendDraft(account, "draft-1", approvedManifest(review));
      },
      { timeoutMs: 10 },
    ),
    { code: "OPERATION_DEADLINE_EXCEEDED" },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.send, 0);
});

test("sendDraft reconstructs approved reply-thread headers", async () => {
  const { calls, mail } = harness({
    full: fullDraft({
      payload: plainPayload({
        headers: [
          { name: "In-Reply-To", value: "<parent@example.com>" },
          { name: "References", value: "<root@example.com> <parent@example.com>" },
        ],
      }),
    }),
  });
  const review = await mail.reviewDraft(account, "draft-1");
  const manifest = approvedManifest(review);

  await mail.sendDraft(account, "draft-1", manifest);

  assert.equal(
    calls.sendRequests[0].requestBody.message.raw,
    buildRawMessage({
      from: manifest.from,
      to: manifest.to,
      cc: manifest.cc,
      bcc: manifest.bcc,
      subject: manifest.subject,
      body: manifest.body,
      inReplyTo: "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
    }),
  );
});

test("sendDraft fails closed when no expected revision is supplied", async () => {
  const { calls, mail } = harness();

  await assert.rejects(mail.sendDraft(account, "draft-1"), {
    code: "DRAFT_CHANGED",
  });

  assert.equal(calls.get.length, 0);
  assert.equal(calls.send, 0);
});

test("sendDraft freezes approved bytes across a post-verification provider race", async () => {
  const mutatedRaw = rawDraft({
    raw: encode(
      "From: attacker@example.net\r\nTo: hidden@example.net\r\nX-Late: injected\r\n\r\nChanged.\r\n",
    ),
  });
  const { calls, mail } = harness({
    beforeSend({ setRaw }) {
      setRaw(mutatedRaw);
    },
  });
  const review = await mail.reviewDraft(account, "draft-1");
  const manifest = approvedManifest(review);

  await mail.sendDraft(account, "draft-1", manifest);

  const sentRaw = calls.sendRequests[0].requestBody.message.raw;
  assert.equal(
    sentRaw,
    buildRawMessage({
      from: manifest.from,
      to: manifest.to,
      cc: manifest.cc,
      bcc: manifest.bcc,
      subject: manifest.subject,
      body: manifest.body,
    }),
  );
  const decoded = Buffer.from(sentRaw, "base64url").toString("utf8");
  assert.doesNotMatch(decoded, /attacker|hidden|X-Late|Changed/u);
});

test("sendDraft strips provider display names and unreviewed custom headers", async () => {
  const rawMessage = [
    "From: Owner <owner@example.com>",
    "To: Recipient <recipient@example.com>",
    "X-Unreviewed-Routing: hidden@example.net",
    "Subject: Status",
    "",
    "Hello, world.",
  ].join("\r\n");
  const { calls, mail } = harness({
    full: fullDraft({
      payload: plainPayload({
        headers: [{ name: "X-Unreviewed-Routing", value: "hidden@example.net" }],
      }),
    }),
    raw: rawDraft({ raw: encode(rawMessage) }),
  });
  const review = await mail.reviewDraft(account, "draft-1");

  await mail.sendDraft(account, "draft-1", approvedManifest(review));

  const sentRaw = Buffer.from(
    calls.sendRequests[0].requestBody.message.raw,
    "base64url",
  ).toString("utf8");
  assert.match(sentRaw, /^From: owner@example\.com\r\nTo: recipient@example\.com\r\n/u);
  assert.doesNotMatch(sentRaw, /Owner <|Recipient <|X-Unreviewed-Routing|hidden@example\.net/u);
});

test("sendDraft rejects partial and malformed manifests before provider access", async (context) => {
  const { calls, mail } = harness();
  for (const [name, manifest] of [
    ["missing", undefined],
    ["legacy revision only", { messageId: "message-1", threadId: "thread-1" }],
    ["wrong version", { manifestVersion: 99 }],
  ]) {
    await context.test(name, async () => {
      await assert.rejects(mail.sendDraft(account, "draft-1", manifest), {
        code: "DRAFT_CHANGED",
      });
    });
  }
  assert.equal(calls.get.length, 0);
  assert.equal(calls.send, 0);
});
