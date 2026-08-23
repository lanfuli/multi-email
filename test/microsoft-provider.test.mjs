import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { emptyConfig, validateConfig } from "../src/config.mjs";
import { credentialAccountKey, MemoryCredentialStore } from "../src/keychain.mjs";
import { runWithOperationDeadline } from "../src/operation-deadline.mjs";
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

async function startLocalServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function closeLocalServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

const REVIEW_SELECT =
  "id,conversationId,isDraft,from,sender,replyTo,toRecipients,ccRecipients,bccRecipients,subject,body,hasAttachments,importance,isReadReceiptRequested,isDeliveryReceiptRequested,changeKey,lastModifiedDateTime";

function reviewPath(draftId) {
  return `me/messages/${encodeURIComponent(draftId)}?$select=${REVIEW_SELECT}`;
}

function attachmentPath(draftId) {
  return `me/messages/${encodeURIComponent(draftId)}/attachments?$top=1&$select=id,name,contentType,size,isInline`;
}

function rawPath(draftId) {
  return `me/messages/${encodeURIComponent(draftId)}/$value`;
}

function revisionPath(draftId) {
  return `me/messages/${encodeURIComponent(draftId)}?$select=id,conversationId,isDraft,changeKey,lastModifiedDateTime`;
}

function plainTextMime(body = "Body", extraHeaders = []) {
  return Buffer.from(
    [
      "From: Sales <sales@example.com>",
      "To: One <one@example.com>",
      "Subject: Subject",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      ...extraHeaders,
      "",
      body,
      "",
    ].join("\r\n"),
    "utf8",
  );
}

function rawHash(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function revisionSnapshot(draft = reviewableDraft()) {
  return {
    id: draft.id,
    conversationId: draft.conversationId,
    isDraft: draft.isDraft,
    changeKey: draft.changeKey,
    lastModifiedDateTime: draft.lastModifiedDateTime,
  };
}

function reviewableDraft(overrides = {}) {
  return {
    id: "draft-2",
    conversationId: "thread-2",
    isDraft: true,
    from: { emailAddress: { name: "Sales", address: "Sales@Example.COM" } },
    sender: { emailAddress: { name: "Sales", address: "Sales@Example.COM" } },
    replyTo: [],
    toRecipients: [{ emailAddress: { name: "One", address: "ONE@Example.COM" } }],
    ccRecipients: [{ emailAddress: { name: "Two", address: "TWO@Example.COM" } }],
    bccRecipients: [{ emailAddress: { name: "Three", address: "THREE@Example.COM" } }],
    subject: "Subject",
    body: { contentType: "Text", content: "Body" },
    hasAttachments: false,
    importance: "normal",
    isReadReceiptRequested: false,
    isDeliveryReceiptRequested: false,
    changeKey: "CQAAABYAA-review-1",
    lastModifiedDateTime: "2026-08-21T12:00:00Z",
    ...overrides,
  };
}

function fullManifest(review, revision = {}) {
  return {
    manifestVersion: 1,
    policyVersion: 2,
    account: review.account,
    provider: "microsoft",
    authenticatedPrincipal: account.email,
    mailboxResource: account.email,
    draftId: review.draftId,
    messageId: review.messageId,
    threadId: review.threadId,
    from: review.from,
    sender: review.sender,
    replyTo: [...review.replyTo],
    to: [...review.to],
    cc: [...review.cc],
    bcc: [...review.bcc],
    subject: review.subject,
    inReplyTo: review.inReplyTo || "",
    references: review.references || "",
    body: review.body,
    bodyFormat: "text",
    bodySha256: createHash("sha256").update(review.body, "utf8").digest("hex"),
    attachments: [],
    completeness: "complete",
    providerRevision: {
      messageId: review.messageId,
      threadId: review.threadId,
      rawPayloadSha256: review.rawPayloadSha256,
      changeKey: review.changeKey,
      lastModifiedDateTime: review.lastModifiedDateTime,
      ...revision,
    },
  };
}

function sendReview({
  draftId = "draft/send",
  threadId = "thread-send",
  body = "Send body",
  raw = plainTextMime(body),
  changeKey = "CQAAABYAA-send-1",
  lastModifiedDateTime = "2026-08-21T13:00:00Z",
  ...overrides
} = {}) {
  return {
    account: account.alias,
    draftId,
    messageId: draftId,
    threadId,
    from: account.email,
    sender: account.email,
    replyTo: [],
    to: ["one@example.com"],
    cc: ["two@example.com"],
    bcc: ["three@example.com"],
    subject: "Approved subject",
    inReplyTo: "",
    references: "",
    body,
    bodyFormat: "text",
    attachments: [],
    completeness: "complete",
    truncated: false,
    rawPayloadSha256: rawHash(raw),
    changeKey,
    lastModifiedDateTime,
    ...overrides,
  };
}

function decodeFrozenMime(base64) {
  const raw = Buffer.from(base64, "base64").toString("utf8");
  const boundary = raw.indexOf("\r\n\r\n");
  assert.notEqual(boundary, -1);
  const headers = raw.slice(0, boundary);
  const encodedBody = raw.slice(boundary + 4).replaceAll("\r\n", "");
  return {
    raw,
    headers,
    body: Buffer.from(encodedBody, "base64").toString("utf8"),
  };
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

test("MSAL uses one bounded network client for authority and token requests", async (context) => {
  await context.test("unexpected identity origin is refused before fetch", async () => {
    let fetchCalls = 0;
    const mail = provider({
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    });
    const networkClient = mail.createApplication(account).config.system.networkClient;

    await assert.rejects(
      networkClient.sendGetRequestAsync(
        "https://login.microsoftonline.com.evil.test/token?secret=must-not-leak",
      ),
      (error) => {
        assert.equal(error.code, "INVALID_PROVIDER_RESPONSE");
        assert.doesNotMatch(
          `${error.message} ${JSON.stringify(error.details)}`,
          /must-not-leak|evil\.test|secret/iu,
        );
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
  });

  await context.test("application wiring and bounded JSON response", async () => {
    let response;
    const server = await startLocalServer((_request, localResponse) => {
      localResponse.writeHead(200, {
        "content-type": "application/json",
        "x-test-header": "safe",
      });
      localResponse.end(JSON.stringify({ issuer: "microsoft" }));
    });
    const mail = provider({
      fetchImpl: async (_url, options) => {
        response = await fetch(`http://127.0.0.1:${server.address().port}/metadata`, options);
        return response;
      },
    });

    try {
      const application = mail.createApplication(account);
      const networkClient = application.config.system.networkClient;
      assert.equal(application.config.system.disableInternalRetries, true);
      assert.equal(typeof networkClient.sendGetRequestAsync, "function");
      assert.equal(typeof networkClient.sendPostRequestAsync, "function");
      const result = await networkClient.sendGetRequestAsync(
        "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { issuer: "microsoft" });
      assert.equal(result.headers["x-test-header"], "safe");
      assert.equal(response.body.locked, false);
    } finally {
      await closeLocalServer(server);
    }
  });

  await context.test("redirect does not replay a token POST", async () => {
    const requests = [];
    const sensitiveBody = "refresh_token=must-not-leak";
    const server = await startLocalServer((request, response) => {
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
    const mail = provider({
      fetchImpl: async (_url, options) =>
        fetch(`http://127.0.0.1:${server.address().port}/first`, options),
    });

    try {
      const networkClient = mail.createApplication(account).config.system.networkClient;
      await assert.rejects(
        networkClient.sendPostRequestAsync(
          "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
          {
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: sensitiveBody,
          },
        ),
        (error) => {
          assert.equal(error.code, "MICROSOFT_NETWORK_ERROR");
          assert.doesNotMatch(
            `${error.message} ${JSON.stringify(error.details)}`,
            /must-not-leak|127\.0\.0\.1|oauth2/iu,
          );
          return true;
        },
      );
      assert.deepEqual(requests, [
        { method: "POST", path: "/first", body: sensitiveBody },
      ]);
    } finally {
      await closeLocalServer(server);
    }
  });

  await context.test("oversized identity response is cancelled and released", async () => {
    let observedResponse;
    let responseClosed = false;
    let settleClosed;
    const closed = new Promise((resolve) => {
      settleClosed = resolve;
    });
    const server = await startLocalServer((_request, response) => {
      response.on("close", () => {
        responseClosed = true;
        settleClosed();
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024 + 1),
      });
      response.write('{"sensitive":"must-not-leak"');
    });
    const mail = provider({
      fetchImpl: async (_url, options) => {
        observedResponse = await fetch(
          `http://127.0.0.1:${server.address().port}/oversized`,
          options,
        );
        return observedResponse;
      },
    });

    try {
      const networkClient = mail.createApplication(account).config.system.networkClient;
      await assert.rejects(
        networkClient.sendGetRequestAsync(
          "https://login.microsoftonline.com/organizations/discovery/v2.0/keys",
        ),
        (error) => {
          assert.equal(error.code, "INVALID_PROVIDER_RESPONSE");
          assert.doesNotMatch(
            `${error.message} ${JSON.stringify(error.details)}`,
            /must-not-leak|127\.0\.0\.1|discovery/iu,
          );
          return true;
        },
      );
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("identity response stayed open")), 1_000),
        ),
      ]);
      assert.equal(responseClosed, true);
      assert.equal(observedResponse.body.locked, false);
    } finally {
      await closeLocalServer(server);
    }
  });

  await context.test("stalled token response is aborted within the shared deadline", async () => {
    const requests = [];
    let responseClosed = false;
    let settleClosed;
    const closed = new Promise((resolve) => {
      settleClosed = resolve;
    });
    const server = await startLocalServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("close", () => {
        responseClosed = true;
        settleClosed();
      });
    });
    const mail = provider({
      graphRequestTimeoutMs: 1_000,
      fetchImpl: async (_url, options) =>
        fetch(`http://127.0.0.1:${server.address().port}/stalled`, options),
    });

    try {
      const networkClient = mail.createApplication(account).config.system.networkClient;
      const startedAt = Date.now();
      await assert.rejects(
        runWithOperationDeadline(
          () =>
            networkClient.sendPostRequestAsync(
              "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
              { body: "refresh_token=must-not-leak" },
            ),
          { timeoutMs: 400 },
        ),
        (error) => {
          assert.equal(error.code, "MICROSOFT_TIMEOUT");
          assert.ok(error.details.timeoutMs > 0 && error.details.timeoutMs <= 150);
          assert.doesNotMatch(
            `${error.message} ${JSON.stringify(error.details)}`,
            /must-not-leak|127\.0\.0\.1|oauth2/iu,
          );
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 400);
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("stalled identity response stayed open")), 1_000),
        ),
      ]);
      assert.equal(responseClosed, true);
      assert.deepEqual(requests, [
        {
          method: "POST",
          path: "/stalled",
          body: "refresh_token=must-not-leak",
        },
      ]);
    } finally {
      await closeLocalServer(server);
    }
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

test("Graph rejects 307 redirects without replaying a POST body", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: request.headers.authorization,
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

  const mail = provider({
    fetchImpl: async (_url, options) =>
      fetch(`http://127.0.0.1:${server.address().port}/first`, options),
  });
  try {
    await assert.rejects(
      mail.graphRequestWithToken("not-a-real-token", "me/messages/draft-1/send", {
        method: "POST",
        body: {},
      }),
      { code: "MICROSOFT_NETWORK_ERROR" },
    );
    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/first",
        body: "{}",
        authorization: "Bearer not-a-real-token",
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("raw Graph responses enforce a byte cap before buffering MIME", async () => {
  const mail = provider({
    fetchImpl: async () =>
      new Response("x".repeat(17), {
        status: 200,
        headers: { "content-length": "17", "content-type": "message/rfc822" },
      }),
  });

  await assert.rejects(
    mail.graphRequestWithToken("not-a-real-token", "me/messages/draft-1/$value", {
      responseType: "buffer",
      maxResponseBytes: 16,
    }),
    { code: "DRAFT_TOO_LARGE" },
  );
});

test("Graph requests enforce a provider deadline and safely classify aborts", async (context) => {
  await context.test("deadline", async () => {
    const mail = provider({
      graphRequestTimeoutMs: 10,
      fetchImpl: async (_url, { signal }) =>
        new Promise((resolve, reject) => {
          const pending = setTimeout(() => resolve(new Response("{}")), 1_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(pending);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });

    await assert.rejects(
      mail.graphRequestWithToken("not-a-real-token", "me/messages"),
      (error) => {
        assert.equal(error.code, "MICROSOFT_TIMEOUT");
        assert.deepEqual(error.details, { timeoutMs: 10 });
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /token/iu);
        return true;
      },
    );
  });

  await context.test("abort", async () => {
    const mail = provider({
      fetchImpl: async () => {
        throw new DOMException("Bearer must-not-leak", "AbortError");
      },
    });

    await assert.rejects(
      mail.graphRequestWithToken("not-a-real-token", "me/messages"),
      (error) => {
        assert.equal(error.code, "MICROSOFT_REQUEST_ABORTED");
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /must-not-leak/iu);
        return true;
      },
    );
  });

  assert.ok(provider({ graphRequestTimeoutMs: 121_000 }).graphRequestTimeoutMs < 120_000);
});

test("Microsoft consumes one absolute MCP deadline across token, identity, and Graph work", async (context) => {
  await context.test("stuck silent token acquisition", async () => {
    const mail = provider();
    mail.application = async () => ({
      application: {
        async getAllAccounts() {
          return [{ username: account.email }];
        },
        async acquireTokenSilent() {
          return new Promise(() => {});
        },
      },
      record: null,
    });
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await assert.rejects(
        runWithOperationDeadline(() => mail.accessToken(account), { timeoutMs: 20 }),
        { code: "MICROSOFT_TIMEOUT" },
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });

  await context.test("stuck silent token acquisition outside an MCP operation", async () => {
    const mail = provider({ graphRequestTimeoutMs: 20 });
    mail.application = async () => ({
      application: {
        async getAllAccounts() {
          return [{ username: account.email }];
        },
        async acquireTokenSilent() {
          return new Promise(() => {});
        },
      },
      record: null,
    });

    await assert.rejects(mail.accessToken(account), { code: "MICROSOFT_TIMEOUT" });
  });

  await context.test("stuck application/cache load outside an MCP operation", async () => {
    const mail = provider({ graphRequestTimeoutMs: 20 });
    mail.application = async () => new Promise(() => {});

    await assert.rejects(mail.accessToken(account), { code: "MICROSOFT_TIMEOUT" });
  });

  await context.test("expired budget prevents a late token request", async () => {
    let tokenCalls = 0;
    const mail = provider();
    mail.application = async () => ({
      application: {
        async getAllAccounts() {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return [{ username: account.email }];
        },
        async acquireTokenSilent() {
          tokenCalls += 1;
          return { accessToken: "must-not-be-issued" };
        },
      },
      record: null,
    });

    await assert.rejects(
      runWithOperationDeadline(() => mail.accessToken(account), { timeoutMs: 20 }),
      { code: "MICROSOFT_TIMEOUT" },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(tokenCalls, 0);
  });

  await context.test("initial identity verification", async () => {
    const mail = provider({
      graphRequestTimeoutMs: 1_000,
      fetchImpl: async (_url, { signal }) =>
        new Promise((resolve, reject) => {
          const pending = setTimeout(() => resolve(new Response("{}")), 1_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(pending);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    mail.application = async () => ({
      application: {
        async getAllAccounts() {
          return [{ username: account.email }];
        },
        async acquireTokenSilent() {
          return {
            accessToken: "not-a-real-token",
            scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
          };
        },
      },
      record: null,
    });

    await assert.rejects(
      runWithOperationDeadline(() => mail.accessToken(account), { timeoutMs: 350 }),
      (error) => ["MICROSOFT_TIMEOUT", "OPERATION_DEADLINE_EXCEEDED"].includes(error.code),
    );
  });

  await context.test("cumulative Graph calls", async () => {
    let fetchCalls = 0;
    const mail = provider({
      graphRequestTimeoutMs: 1_000,
      fetchImpl: async (_url, { signal }) => {
        fetchCalls += 1;
        return new Promise((resolve, reject) => {
          const pending = setTimeout(() => resolve(new Response("{}")), 240);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(pending);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });
    mail.accessToken = async () => "not-a-real-token";

    await assert.rejects(
      runWithOperationDeadline(
        () => mail.markRead(account, ["one", "two", "three"], true),
        { timeoutMs: 700 },
      ),
      (error) => {
        assert.equal(error.code, "PARTIAL_MARK_READ");
        assert.deepEqual(error.details.completedIds, ["one"]);
        assert.equal(error.details.unknownOutcomeId, "two");
        assert.deepEqual(error.details.remainingIds, ["three"]);
        assert.equal(error.details.causeCode, "MICROSOFT_TIMEOUT");
        return true;
      },
    );
    assert.equal(fetchCalls, 2);
  });

  await context.test("batch receipt survives a later stuck silent token", async () => {
    let fetchCalls = 0;
    let tokenCalls = 0;
    const mail = provider({
      graphRequestTimeoutMs: 1_000,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}");
      },
    });
    mail.verifiedAliases.add(account.alias);
    mail.application = async () => ({
      application: {
        async getAllAccounts() {
          return [{ username: account.email }];
        },
        async acquireTokenSilent() {
          tokenCalls += 1;
          if (tokenCalls === 1) {
            return {
              accessToken: "not-a-real-token",
              scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
            };
          }
          return new Promise(() => {});
        },
      },
      record: null,
    });

    await assert.rejects(
      runWithOperationDeadline(
        () => mail.markRead(account, ["one", "two", "three"], true),
        { timeoutMs: 300 },
      ),
      (error) => {
        assert.equal(error.code, "PARTIAL_MARK_READ");
        assert.deepEqual(error.details, {
          changed: 1,
          requested: 3,
          isRead: true,
          completedIds: ["one"],
          failedId: "two",
          remainingIds: ["three"],
          causeCode: "MICROSOFT_TIMEOUT",
        });
        return true;
      },
    );
    assert.equal(tokenCalls, 2);
    assert.equal(fetchCalls, 1);
  });

  await context.test("batch receipt survives a later stuck account-cache read", async () => {
    let applicationCalls = 0;
    let fetchCalls = 0;
    let tokenCalls = 0;
    const mail = provider({
      graphRequestTimeoutMs: 1_000,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}");
      },
    });
    mail.verifiedAliases.add(account.alias);
    mail.application = async () => {
      applicationCalls += 1;
      return {
        application: {
          async getAllAccounts() {
            if (applicationCalls === 2) return new Promise(() => {});
            return [{ username: account.email }];
          },
          async acquireTokenSilent() {
            tokenCalls += 1;
            return {
              accessToken: "not-a-real-token",
              scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
            };
          },
        },
        record: null,
      };
    };

    await assert.rejects(
      runWithOperationDeadline(
        () => mail.markRead(account, ["one", "two"], true),
        { timeoutMs: 400 },
      ),
      (error) => {
        assert.equal(error.code, "PARTIAL_MARK_READ");
        assert.deepEqual(error.details, {
          changed: 1,
          requested: 2,
          isRead: true,
          completedIds: ["one"],
          failedId: "two",
          remainingIds: [],
          causeCode: "MICROSOFT_TIMEOUT",
        });
        return true;
      },
    );
    assert.equal(applicationCalls, 2);
    assert.equal(tokenCalls, 1);
    assert.equal(fetchCalls, 1);
  });
});

test("Graph JSON responses are stream-limited before parsing", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024 + 1).fill(0x20);
  const mail = provider({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(
    mail.graphRequestWithToken("not-a-real-token", "me/messages"),
    { code: "INVALID_PROVIDER_RESPONSE" },
  );
  assert.equal(cancelled, true);
});

test("Graph cancels a readable response rejected by Content-Length", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    },
  );
  const mail = provider({
    fetchImpl: async () => response,
  });

  await assert.rejects(
    mail.graphRequestWithToken("not-a-real-token", "me/messages"),
    { code: "INVALID_PROVIDER_RESPONSE" },
  );
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("Graph JSON errors preserve safe status details without exposing provider text", async (context) => {
  await context.test("malformed success JSON", async () => {
    const mail = provider({
      fetchImpl: async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await assert.rejects(
      mail.graphRequestWithToken("not-a-real-token", "me/messages"),
      { code: "INVALID_PROVIDER_RESPONSE" },
    );
  });

  await context.test("provider error JSON", async () => {
    const mail = provider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { code: "TooManyRequests", message: "Bearer must-not-leak" },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "7" },
          },
        ),
    });

    await assert.rejects(
      mail.graphRequestWithToken("not-a-real-token", "me/messages"),
      (error) => {
        assert.equal(error.code, "MICROSOFT_GRAPH_ERROR");
        assert.deepEqual(error.details, {
          status: 429,
          providerCode: "TooManyRequests",
          retryAfter: "7",
        });
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /must-not-leak/iu);
        return true;
      },
    );
  });

  await context.test("malicious provider details", async () => {
    const response = new Response(
      JSON.stringify({
        error: { code: `Bad\n${"x".repeat(200)}`, message: "must-not-leak" },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    Object.defineProperty(response, "headers", {
      value: {
        get(name) {
          if (name.toLowerCase() === "retry-after") return "7\r\nX-Leak: must-not-leak";
          return null;
        },
      },
    });
    const mail = provider({
      fetchImpl: async () => response,
    });

    await assert.rejects(
      mail.graphRequestWithToken("not-a-real-token", "me/messages"),
      (error) => {
        assert.deepEqual(error.details, {
          status: 429,
          providerCode: null,
          retryAfter: null,
        });
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /must-not-leak/iu);
        return true;
      },
    );
  });

  await context.test("oversized provider error body", async () => {
    let cancelled = false;
    const mail = provider({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "retry-after": "12",
            },
          },
        ),
    });

    await assert.rejects(
      mail.graphRequestWithToken("not-a-real-token", "me/messages"),
      (error) => {
        assert.equal(error.code, "MICROSOFT_GRAPH_ERROR");
        assert.deepEqual(error.details, {
          status: 503,
          providerCode: null,
          retryAfter: "12",
        });
        return true;
      },
    );
    assert.equal(cancelled, true);
  });
});

test("Microsoft batch failures identify completed, failed, and remaining message IDs", async (context) => {
  const messageIds = ["one", "two", "three"];
  const providerFailure = Object.assign(new Error("Bearer must-not-leak"), {
    code: "MICROSOFT_GRAPH_ERROR",
    details: { status: 400 },
  });

  function assertPartial(error, code, extra = {}) {
    assert.equal(error.code, code);
    assert.deepEqual(error.details, {
      ...extra,
      requested: 3,
      completedIds: ["one"],
      failedId: "two",
      remainingIds: ["three"],
      causeCode: "MICROSOFT_GRAPH_ERROR",
    });
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /must-not-leak/iu);
    return true;
  }

  await context.test("archive", async () => {
    const mail = provider();
    mail.graphRequest = async (_account, path) => {
      if (path === "me/mailFolders/archive?$select=id,displayName") return { id: "archive" };
      if (path === "me/messages/one?$select=id,parentFolderId") return { parentFolderId: "inbox" };
      if (path === "me/messages/one/move") return { id: "one" };
      if (path === "me/messages/two?$select=id,parentFolderId") throw providerFailure;
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.archive(account, messageIds),
      (error) => assertPartial(error, "PARTIAL_ARCHIVE", { archived: 1 }),
    );
  });

  await context.test("mark read", async () => {
    const mail = provider();
    mail.graphRequest = async (_account, path) => {
      if (path === "me/messages/one") return { id: "one" };
      if (path === "me/messages/two") throw providerFailure;
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.markRead(account, messageIds, true),
      (error) => assertPartial(error, "PARTIAL_MARK_READ", { changed: 1, isRead: true }),
    );
  });

  await context.test("categories", async () => {
    const mail = provider();
    mail.graphRequest = async (_account, path, options = {}) => {
      if (path === "me/messages/one?$select=id,categories") {
        return { id: "one", categories: ["remove"] };
      }
      if (path === "me/messages/one" && options.method === "PATCH") return { id: "one" };
      if (path === "me/messages/two?$select=id,categories") throw providerFailure;
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.modifyCategories(account, messageIds, { add: ["add"], remove: ["remove"] }),
      (error) => assertPartial(error, "PARTIAL_CATEGORY_UPDATE", { changed: 1 }),
    );
  });
});

test("Microsoft batch receipts distinguish definite failures from unknown mutation outcomes", async (context) => {
  const messageIds = ["one", "two", "three"];
  const unknownFailure = Object.assign(new Error("Bearer must-not-leak"), {
    code: "MICROSOFT_TIMEOUT",
  });

  function assertUnknown(error, code, extra = {}) {
    assert.equal(error.code, code);
    assert.deepEqual(error.details, {
      ...extra,
      requested: 3,
      completedIds: ["one"],
      unknownOutcomeId: "two",
      remainingIds: ["three"],
      causeCode: "MICROSOFT_TIMEOUT",
    });
    assert.equal("failedId" in error.details, false);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /must-not-leak/iu);
    return true;
  }

  await context.test("archive move", async () => {
    const mail = provider();
    mail.graphRequest = async (_account, path, options = {}) => {
      if (path === "me/mailFolders/archive?$select=id,displayName") return { id: "archive" };
      if (path === "me/messages/one?$select=id,parentFolderId") return { parentFolderId: "inbox" };
      if (path === "me/messages/one/move") return { id: "one" };
      if (path === "me/messages/two?$select=id,parentFolderId") return { parentFolderId: "inbox" };
      if (path === "me/messages/two/move") {
        options.onDispatch();
        throw unknownFailure;
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.archive(account, messageIds),
      (error) => assertUnknown(error, "PARTIAL_ARCHIVE", { archived: 1 }),
    );
  });

  await context.test("mark read", async () => {
    const mail = provider();
    mail.graphRequest = async (_account, path, options = {}) => {
      if (path === "me/messages/one") return { id: "one" };
      if (path === "me/messages/two") {
        options.onDispatch();
        throw unknownFailure;
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.markRead(account, messageIds, true),
      (error) => assertUnknown(error, "PARTIAL_MARK_READ", { changed: 1, isRead: true }),
    );
  });

  await context.test("category patch", async () => {
    const mail = provider();
    mail.graphRequest = async (_account, path, options = {}) => {
      if (path === "me/messages/one?$select=id,categories") return { categories: [] };
      if (path === "me/messages/one" && options.method === "PATCH") return { id: "one" };
      if (path === "me/messages/two?$select=id,categories") return { categories: [] };
      if (path === "me/messages/two" && options.method === "PATCH") {
        options.onDispatch();
        throw unknownFailure;
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.modifyCategories(account, messageIds, { add: ["add"] }),
      (error) => assertUnknown(error, "PARTIAL_CATEGORY_UPDATE", { changed: 1 }),
    );
  });

  await context.test("malicious cause code", async () => {
    const mail = provider();
    mail.graphRequest = async () => {
      throw Object.assign(new Error("must-not-leak"), {
        code: `BAD\n${"x".repeat(200)}`,
        details: { status: 400 },
      });
    };

    await assert.rejects(
      mail.markRead(account, ["one"], true),
      (error) => {
        assert.deepEqual(error.details, {
          changed: 0,
          requested: 1,
          isRead: true,
          completedIds: [],
          failedId: "one",
          remainingIds: [],
          causeCode: null,
        });
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /must-not-leak/iu);
        return true;
      },
    );
  });

  await context.test("token failure before dispatch", async () => {
    const mail = provider();
    let fetchCalls = 0;
    mail.accessToken = async () => {
      throw new Error("token unavailable");
    };
    mail.fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    };

    await assert.rejects(
      mail.markRead(account, ["one"], true),
      (error) => {
        assert.deepEqual(error.details, {
          changed: 0,
          requested: 1,
          isRead: true,
          completedIds: [],
          failedId: "one",
          remainingIds: [],
          causeCode: null,
        });
        assert.equal("unknownOutcomeId" in error.details, false);
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
  });

  for (const status of [408, 500, 502, 503, 504]) {
    await context.test(`dispatched HTTP ${status} remains unknown`, async () => {
      let applied = false;
      const attempted = [];
      const mail = provider({
        fetchImpl: async (url) => {
          const id = new URL(url).pathname.split("/").at(-1);
          attempted.push(id);
          if (id === "one") {
            return new Response(JSON.stringify({ id }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (id === "two") {
            applied = true;
            return new Response(JSON.stringify({ error: { code: "ServerError" } }), {
              status,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error("third mutation must remain untouched");
        },
      });
      mail.accessToken = async () => "not-a-real-token";

      await assert.rejects(
        mail.markRead(account, messageIds, true),
        (error) => {
          assert.equal(applied, true);
          assert.deepEqual(attempted, ["one", "two"]);
          assert.deepEqual(error.details, {
            changed: 1,
            requested: 3,
            isRead: true,
            completedIds: ["one"],
            unknownOutcomeId: "two",
            remainingIds: ["three"],
            causeCode: "MICROSOFT_GRAPH_ERROR",
          });
          assert.equal("failedId" in error.details, false);
          return true;
        },
      );
    });
  }

  await context.test("dispatched HTTP 400 is a definite rejection", async () => {
    const mail = provider({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: "InvalidRequest" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    mail.accessToken = async () => "not-a-real-token";

    await assert.rejects(
      mail.markRead(account, ["one"], true),
      (error) => {
        assert.deepEqual(error.details, {
          changed: 0,
          requested: 1,
          isRead: true,
          completedIds: [],
          failedId: "one",
          remainingIds: [],
          causeCode: "MICROSOFT_GRAPH_ERROR",
        });
        assert.equal("unknownOutcomeId" in error.details, false);
        return true;
      },
    );
  });
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
    if (path === reviewPath("draft/1")) {
      return reviewableDraft({
        id: "draft/1",
        conversationId: "thread-1",
        toRecipients: [
          { emailAddress: { name: "Customer", address: "Customer@Example.COM" } },
        ],
        ccRecipients: [{ emailAddress: { address: "Copy@Example.COM" } }],
        bccRecipients: [{ emailAddress: { address: "Audit@Example.COM" } }],
        subject: "RE: Question",
        body: { contentType: "text", content: "Reply body" },
      });
    }
    if (path === rawPath("draft/1")) {
      assert.equal(options.responseType, "buffer");
      return plainTextMime("Reply body");
    }
    if (path === attachmentPath("draft/1")) {
      return { value: [] };
    }
    if (path === revisionPath("draft/1")) {
      return revisionSnapshot(reviewableDraft({ id: "draft/1", conversationId: "thread-1" }));
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
  assert.equal(calls.length, 7);
});

test("reviewDraft returns a complete manifest bound to stable raw plain-text MIME", async () => {
  const mail = provider();
  const calls = [];
  const raw = plainTextMime();
  mail.graphRequest = async (_account, path, options) => {
    calls.push({ path, options });
    if (path === reviewPath("draft-2")) return reviewableDraft();
    if (path === rawPath("draft-2")) return raw;
    if (path === attachmentPath("draft-2")) return { value: [] };
    if (path === revisionPath("draft-2")) return revisionSnapshot();
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  const review = await mail.reviewDraft(account, "draft-2");
  assert.deepEqual(review, {
    account: "m365",
    draftId: "draft-2",
    messageId: "draft-2",
    threadId: "thread-2",
    from: "sales@example.com",
    sender: "sales@example.com",
    replyTo: [],
    to: ["one@example.com"],
    cc: ["two@example.com"],
    bcc: ["three@example.com"],
    subject: "Subject",
    inReplyTo: "",
    references: "",
    body: "Body",
    bodyFormat: "text",
    attachments: [],
    completeness: "complete",
    truncated: false,
    rawPayloadSha256: rawHash(raw),
    changeKey: "CQAAABYAA-review-1",
    lastModifiedDateTime: "2026-08-21T12:00:00Z",
  });
  assert.deepEqual(calls.map(({ path }) => path), [
    reviewPath("draft-2"),
    rawPath("draft-2"),
    attachmentPath("draft-2"),
    revisionPath("draft-2"),
  ]);
  assert.match(calls[0].options.headers.prefer, /outlook\.body-content-type="text"/iu);
  assert.equal(calls[1].options.responseType, "buffer");
  assert.equal(calls[1].options.maxResponseBytes, 2 * 1024 * 1024);
});

test("Microsoft config and draft review require canonical OAuth and mailbox values", async () => {
  const invalidConfig = emptyConfig();
  invalidConfig.providers.microsoft = {
    clientId: "not-a-guid",
    tenant: "organizations",
  };
  assert.throws(() => validateConfig(invalidConfig), { code: "INVALID_CONFIG" });

  const directProvider = new MicrosoftProvider({
    config: {
      providers: {
        microsoft: {
          clientId: " ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF ",
          tenant: " Example.OnMicrosoft.COM ",
        },
      },
    },
    credentialStore: new MemoryCredentialStore(),
  });
  assert.deepEqual(directProvider.providerConfig(), {
    clientId: "abcdefab-1234-5678-90ab-abcdefabcdef",
    tenant: "example.onmicrosoft.com",
    authority: "https://login.microsoftonline.com/example.onmicrosoft.com",
  });

  directProvider.config.providers.microsoft.clientId = "not-a-guid";
  assert.throws(() => directProvider.providerConfig(), { code: "INVALID_CONFIG" });

  for (const address of [
    "victim:attacker@example.com",
    "one\0@example.com",
    "malformed",
  ]) {
    const mail = provider();
    mail.graphRequest = async (_account, path) => {
      if (path === reviewPath("draft-address")) {
        return reviewableDraft({
          id: "draft-address",
          toRecipients: [{ emailAddress: { address } }],
        });
      }
      if (path === rawPath("draft-address")) return plainTextMime();
      if (path === attachmentPath("draft-address")) return { value: [] };
      if (path === revisionPath("draft-address")) {
        return revisionSnapshot(reviewableDraft({ id: "draft-address" }));
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(mail.reviewDraft(account, "draft-address"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
  }
});

test("reviewDraft rejects every missing review-required structured Graph field", async () => {
  const cases = [
    "id",
    "conversationId",
    "isDraft",
    "from",
    "replyTo",
    "toRecipients",
    "ccRecipients",
    "bccRecipients",
    "subject",
    "body",
    "body.contentType",
    "body.content",
    "importance",
    "isReadReceiptRequested",
    "isDeliveryReceiptRequested",
    "changeKey",
    "lastModifiedDateTime",
  ];

  for (const field of cases) {
    const mail = provider();
    const draft = structuredClone(reviewableDraft({ id: "draft-incomplete" }));
    const path = field.split(".");
    const owner = path.length === 1 ? draft : draft[path[0]];
    delete owner[path.at(-1)];
    mail.graphRequest = async (_account, requestPath) => {
      if (requestPath === reviewPath("draft-incomplete")) return draft;
      if (requestPath === rawPath("draft-incomplete")) return plainTextMime();
      if (requestPath === attachmentPath("draft-incomplete")) return { value: [] };
      if (requestPath === revisionPath("draft-incomplete")) {
        return revisionSnapshot(reviewableDraft({ id: "draft-incomplete" }));
      }
      throw new Error(`Unexpected Graph request: ${requestPath}`);
    };

    await assert.rejects(
      mail.reviewDraft(account, "draft-incomplete"),
      (error) => ["DRAFT_NOT_REVIEWABLE", "NOT_A_DRAFT"].includes(error.code),
      field,
    );
  }
});

test("reviewDraft rejects non-normal priority and receipt-request semantics", async () => {
  const cases = [
    { name: "high priority", patch: { importance: "high" } },
    { name: "low priority", patch: { importance: "low" } },
    { name: "read receipt", patch: { isReadReceiptRequested: true } },
    { name: "delivery receipt", patch: { isDeliveryReceiptRequested: true } },
  ];

  for (const scenario of cases) {
    const mail = provider();
    mail.graphRequest = async (_account, path) => {
      if (path === reviewPath("draft-semantics")) {
        return reviewableDraft({ id: "draft-semantics", ...scenario.patch });
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.reviewDraft(account, "draft-semantics"),
      (error) => error.code === "DRAFT_NOT_REVIEWABLE",
      scenario.name,
    );
  }
});

test("reviewDraft rejects HTML MIME even when Graph projects the body as text", async () => {
  const mail = provider();
  let attachmentQueries = 0;
  mail.graphRequest = async (_account, path) => {
    if (path === reviewPath("draft-html")) {
      return reviewableDraft({
        id: "draft-html",
        body: { contentType: "Text", content: "Body" },
      });
    }
    if (path === rawPath("draft-html")) {
      return Buffer.from(
        "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<p>Body</p>\r\n",
      );
    }
    if (path === attachmentPath("draft-html")) {
      attachmentQueries += 1;
      return { value: [] };
    }
    if (path === revisionPath("draft-html")) {
      return revisionSnapshot(reviewableDraft({ id: "draft-html" }));
    }
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  await assert.rejects(mail.reviewDraft(account, "draft-html"), {
    code: "DRAFT_NOT_REVIEWABLE",
  });
  assert.equal(attachmentQueries, 1);
});

test("reviewDraft rejects non-canonical, attachment, inline, and unknown raw MIME forms", async () => {
  const replaceHeader = (raw, before, after) =>
    Buffer.from(raw.toString("utf8").replace(before, after), "utf8");
  const cases = [
    {
      name: "multipart",
      raw: Buffer.from(
        "MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=parts\r\n\r\n--parts--\r\n",
      ),
    },
    {
      name: "attachment disposition",
      raw: plainTextMime("Body", ['Content-Disposition: attachment; filename="body.txt"']),
    },
    {
      name: "inline disposition",
      raw: plainTextMime("Body", ["Content-Disposition: inline"]),
    },
    {
      name: "unknown transfer encoding",
      raw: replaceHeader(
        plainTextMime(),
        "Content-Transfer-Encoding: 8bit",
        "Content-Transfer-Encoding: x-custom",
      ),
    },
    {
      name: "missing MIME version",
      raw: replaceHeader(plainTextMime(), "MIME-Version: 1.0\r\n", ""),
    },
    {
      name: "duplicate MIME version",
      raw: replaceHeader(
        plainTextMime(),
        "MIME-Version: 1.0",
        "MIME-Version: 1.0\r\nMIME-Version: 1.0",
      ),
    },
    {
      name: "missing charset",
      raw: replaceHeader(
        plainTextMime(),
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Type: text/plain",
      ),
    },
    {
      name: "content type name star parameter",
      raw: replaceHeader(
        plainTextMime(),
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Type: text/plain; charset=UTF-8; name*=utf-8''body.txt",
      ),
    },
    {
      name: "extra charset parameter",
      raw: replaceHeader(
        plainTextMime(),
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Type: text/plain; charset=UTF-8; charset=us-ascii",
      ),
    },
    {
      name: "missing transfer encoding",
      raw: replaceHeader(plainTextMime(), "Content-Transfer-Encoding: 8bit\r\n", ""),
    },
    {
      name: "duplicate transfer encoding",
      raw: replaceHeader(
        plainTextMime(),
        "Content-Transfer-Encoding: 8bit",
        "Content-Transfer-Encoding: 8bit\r\nContent-Transfer-Encoding: 8bit",
      ),
    },
  ];

  for (const scenario of cases) {
    const mail = provider();
    mail.graphRequest = async (_account, path) => {
      if (path === reviewPath("draft-mime")) {
        return reviewableDraft({ id: "draft-mime" });
      }
      if (path === rawPath("draft-mime")) return scenario.raw;
      if (path === attachmentPath("draft-mime")) return { value: [] };
      if (path === revisionPath("draft-mime")) {
        return revisionSnapshot(reviewableDraft({ id: "draft-mime" }));
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.reviewDraft(account, "draft-mime"),
      (error) => error.code === "DRAFT_NOT_REVIEWABLE",
      scenario.name,
    );
  }
});

test("reviewDraft rejects regular, inline, and paginated attachment results", async () => {
  const cases = [
    {
      name: "regular attachment",
      draft: { hasAttachments: true },
      attachments: { value: [{ id: "attachment-1", isInline: false }] },
    },
    {
      name: "inline attachment hidden by hasAttachments",
      draft: { hasAttachments: false },
      attachments: { value: [{ id: "inline-1", isInline: true }] },
    },
    {
      name: "paginated attachment enumeration",
      draft: { hasAttachments: false },
      attachments: {
        value: [],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/messages/draft-attachments/attachments?$skip=1",
      },
    },
  ];

  for (const scenario of cases) {
    const mail = provider();
    let sendCalls = 0;
    mail.graphRequest = async (_account, path, options = {}) => {
      if (path === reviewPath("draft-attachments")) {
        return reviewableDraft({ id: "draft-attachments", ...scenario.draft });
      }
      if (path === rawPath("draft-attachments")) return plainTextMime();
      if (path === attachmentPath("draft-attachments")) return scenario.attachments;
      if (path === revisionPath("draft-attachments")) {
        return revisionSnapshot(reviewableDraft({ id: "draft-attachments" }));
      }
      if (options.method === "POST") sendCalls += 1;
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.reviewDraft(account, "draft-attachments"),
      (error) => error.code === "DRAFT_NOT_REVIEWABLE",
      scenario.name,
    );
    assert.equal(sendCalls, 0, scenario.name);
  }
});

test("reviewDraft rejects missing or changed From, Sender, and Reply-To identities", async () => {
  const cases = [
    { name: "missing From", patch: { from: null } },
    {
      name: "changed From",
      patch: { from: { emailAddress: { address: "delegate@example.com" } } },
    },
    {
      name: "changed Sender",
      patch: { sender: { emailAddress: { address: "delegate@example.com" } } },
    },
    {
      name: "Reply-To override",
      patch: { replyTo: [{ emailAddress: { address: "reply@example.com" } }] },
    },
  ];

  for (const scenario of cases) {
    const mail = provider();
    mail.graphRequest = async (_account, path) => {
      if (path === reviewPath("draft-identity")) {
        return reviewableDraft({ id: "draft-identity", ...scenario.patch });
      }
      if (path === rawPath("draft-identity")) return plainTextMime();
      if (path === attachmentPath("draft-identity")) return { value: [] };
      if (path === revisionPath("draft-identity")) {
        return revisionSnapshot(reviewableDraft({ id: "draft-identity" }));
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.reviewDraft(account, "draft-identity"),
      (error) => error.code === "DRAFT_NOT_REVIEWABLE",
      scenario.name,
    );
  }
});

test("reviewDraft requires complete Microsoft revision markers", async () => {
  const mail = provider();
  mail.graphRequest = async (_account, path) => {
    if (path === reviewPath("draft-no-revision")) {
      return reviewableDraft({ id: "draft-no-revision", changeKey: null });
    }
    if (path === attachmentPath("draft-no-revision")) return { value: [] };
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  await assert.rejects(mail.reviewDraft(account, "draft-no-revision"), {
    code: "DRAFT_NOT_REVIEWABLE",
  });
});

test("reviewDraft rejects a revision that changes while MIME and attachments are read", async () => {
  const mail = provider();
  mail.graphRequest = async (_account, path) => {
    if (path === reviewPath("draft-race")) {
      return reviewableDraft({ id: "draft-race", changeKey: "before" });
    }
    if (path === rawPath("draft-race")) return plainTextMime();
    if (path === attachmentPath("draft-race")) return { value: [] };
    if (path === revisionPath("draft-race")) {
      return revisionSnapshot(reviewableDraft({ id: "draft-race", changeKey: "after" }));
    }
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  await assert.rejects(mail.reviewDraft(account, "draft-race"), {
    code: "DRAFT_CHANGED",
  });
});

test("sendDraft rejects every missing policy-v2 manifest field before Graph access", async () => {
  const approvedManifest = fullManifest(sendReview());
  const fields = [
    "manifestVersion",
    "policyVersion",
    "account",
    "provider",
    "authenticatedPrincipal",
    "mailboxResource",
    "draftId",
    "messageId",
    "threadId",
    "from",
    "sender",
    "replyTo",
    "to",
    "cc",
    "bcc",
    "subject",
    "inReplyTo",
    "references",
    "body",
    "bodyFormat",
    "bodySha256",
    "attachments",
    "completeness",
    "providerRevision",
    "providerRevision.messageId",
    "providerRevision.threadId",
    "providerRevision.rawPayloadSha256",
    "providerRevision.changeKey",
    "providerRevision.lastModifiedDateTime",
  ];

  for (const field of fields) {
    const mail = provider();
    let graphCalls = 0;
    mail.graphRequest = async () => {
      graphCalls += 1;
      throw new Error("Graph must not be reached for an incomplete approved manifest");
    };
    const candidate = structuredClone(approvedManifest);
    const path = field.split(".");
    const owner = path.length === 1 ? candidate : candidate[path[0]];
    delete owner[path.at(-1)];

    await assert.rejects(
      mail.sendDraft(account, "draft/send", candidate),
      (error) => error.code === "DRAFT_CHANGED",
      field,
    );
    assert.equal(graphCalls, 0, field);
  }
});

test("sendDraft rechecks the source then posts one frozen approved MIME message", async () => {
  const mail = provider();
  const calls = [];
  const approvedBody = "Approved body — exact bytes";
  const approvedRaw = plainTextMime(approvedBody, [
    "X-Unreviewed-Display: must-not-survive",
    "Return-Path: <attacker@example.com>",
    "Disposition-Notification-To: attacker@example.com",
  ]);
  const reviewed = sendReview({ raw: approvedRaw, body: approvedBody });
  const approvedManifest = fullManifest(reviewed);
  let liveRaw = approvedRaw;
  let revisionCalls = 0;
  let postedOptions = null;
  mail.graphRequest = async (_account, path, options = {}) => {
    calls.push({ path, options });
    if (path === revisionPath("draft/send")) {
      revisionCalls += 1;
      const snapshot = {
        id: "draft/send",
        conversationId: "thread-send",
        isDraft: true,
        changeKey: "CQAAABYAA-send-1",
        lastModifiedDateTime: "2026-08-21T13:00:00Z",
      };
      if (revisionCalls === 2) {
        // Simulate another client mutating the retained source draft after the
        // last preflight snapshot but before Graph receives the send request.
        liveRaw = plainTextMime("MUTATED AFTER FINAL CHECK", [
          "X-Injected-Late: must-not-survive",
        ]);
      }
      return snapshot;
    }
    if (path === rawPath("draft/send")) return liveRaw;
    if (path === attachmentPath("draft/send")) return { value: [] };
    if (path === "me/sendMail" && options.method === "POST") {
      postedOptions = options;
      return null;
    }
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  const result = await mail.sendDraft(account, "draft/send", approvedManifest);
  assert.deepEqual(result, {
    account: "m365",
    provider: "microsoft",
    draftId: "draft/send",
    sentMessageId: null,
    sourceDraftRetained: true,
    status: "send_accepted",
  });
  assert.deepEqual(calls.map(({ path }) => path), [
    revisionPath("draft/send"),
    rawPath("draft/send"),
    attachmentPath("draft/send"),
    revisionPath("draft/send"),
    "me/sendMail",
  ]);
  assert.equal(calls.filter(({ options }) => options.method === "POST").length, 1);
  assert.equal(postedOptions.rawBody, true);
  assert.equal(postedOptions.headers["content-type"], "text/plain");

  const frozen = decodeFrozenMime(postedOptions.body);
  assert.match(frozen.headers, /^From: sales@example\.com$/mu);
  assert.match(frozen.headers, /^To: one@example\.com$/mu);
  assert.match(frozen.headers, /^Cc: two@example\.com$/mu);
  assert.match(frozen.headers, /^Bcc: three@example\.com$/mu);
  assert.match(frozen.headers, /^Subject: Approved subject$/mu);
  assert.equal(frozen.body, approvedBody);
  assert.doesNotMatch(frozen.raw, /Sales <sales@example\.com>/u);
  assert.doesNotMatch(frozen.raw, /X-Unreviewed-Display|Return-Path|Disposition-Notification-To/u);
  assert.doesNotMatch(frozen.raw, /X-Injected-Late|MUTATED AFTER FINAL CHECK/u);
});

test("sendDraft attempts the send once when the response outcome is unknown", async () => {
  const mail = provider();
  const raw = plainTextMime("Approved body");
  const approvedManifest = fullManifest(sendReview({ body: "Approved body", raw }));
  let revisionCalls = 0;
  let sendCalls = 0;
  mail.graphRequest = async (_account, path, options = {}) => {
    if (path === revisionPath("draft/send")) {
      revisionCalls += 1;
      return {
        id: "draft/send",
        conversationId: "thread-send",
        isDraft: true,
        changeKey: "CQAAABYAA-send-1",
        lastModifiedDateTime: "2026-08-21T13:00:00Z",
      };
    }
    if (path === rawPath("draft/send")) return raw;
    if (path === attachmentPath("draft/send")) return { value: [] };
    if (path === "me/sendMail" && options.method === "POST") {
      sendCalls += 1;
      options.onDispatch();
      throw Object.assign(new Error("response timed out after dispatch"), {
        code: "MICROSOFT_TIMEOUT",
      });
    }
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  await assert.rejects(
    mail.sendDraft(account, "draft/send", approvedManifest),
    { code: "MICROSOFT_TIMEOUT" },
  );
  assert.equal(revisionCalls, 2);
  assert.equal(sendCalls, 1);
});

test("sendDraft reports failures before send dispatch as definitely unsent", async (context) => {
  const raw = plainTextMime("Approved body");
  const approvedManifest = fullManifest(sendReview({ body: "Approved body", raw }));

  function installPreflight(mail, sendRequest) {
    let revisionCalls = 0;
    mail.graphRequest = async (_account, path, options = {}) => {
      if (path === revisionPath("draft/send")) {
        revisionCalls += 1;
        return {
          id: "draft/send",
          conversationId: "thread-send",
          isDraft: true,
          changeKey: "CQAAABYAA-send-1",
          lastModifiedDateTime: "2026-08-21T13:00:00Z",
        };
      }
      if (path === rawPath("draft/send")) return raw;
      if (path === attachmentPath("draft/send")) return { value: [] };
      if (path === "me/sendMail" && options.method === "POST") {
        return sendRequest(_account, path, options);
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };
    return () => revisionCalls;
  }

  await context.test("draft verification transport failure", async () => {
    let sendCalls = 0;
    const mail = provider();
    mail.graphRequest = async (_account, path, options = {}) => {
      if (options.method === "POST") sendCalls += 1;
      if (path === revisionPath("draft/send")) {
        throw Object.assign(new Error("verification timed out"), {
          code: "MICROSOFT_TIMEOUT",
        });
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.sendDraft(account, "draft/send", approvedManifest),
      (error) => {
        assert.equal(error.code, "SEND_VERIFICATION_FAILED");
        assert.match(error.message, /Nothing was sent\./u);
        assert.deepEqual(error.details, { causeCode: "MICROSOFT_TIMEOUT" });
        return true;
      },
    );
    assert.equal(sendCalls, 0);
  });

  await context.test("access token failure", async () => {
    let fetchCalls = 0;
    const mail = provider({
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    });
    const graphRequest = MicrosoftProvider.prototype.graphRequest.bind(mail);
    mail.accessToken = async () => {
      throw Object.assign(new Error("token wait expired"), { code: "MICROSOFT_TIMEOUT" });
    };
    const revisionCalls = installPreflight(mail, graphRequest);

    await assert.rejects(
      mail.sendDraft(account, "draft/send", approvedManifest),
      (error) => {
        assert.equal(error.code, "SEND_VERIFICATION_FAILED");
        assert.match(error.message, /Nothing was sent\./u);
        assert.deepEqual(error.details, { causeCode: "MICROSOFT_TIMEOUT" });
        return true;
      },
    );
    assert.equal(revisionCalls(), 2);
    assert.equal(fetchCalls, 0);
  });

  await context.test("request budget failure", async () => {
    let fetchCalls = 0;
    const mail = provider({
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    });
    const graphRequest = MicrosoftProvider.prototype.graphRequest.bind(mail);
    mail.accessToken = async () => "not-a-real-token";
    const revisionCalls = installPreflight(mail, graphRequest);

    await assert.rejects(
      runWithOperationDeadline(
        () => mail.sendDraft(account, "draft/send", approvedManifest),
        { timeoutMs: 200 },
      ),
      (error) => {
        assert.equal(error.code, "SEND_VERIFICATION_FAILED");
        assert.match(error.message, /Nothing was sent\./u);
        assert.deepEqual(error.details, { causeCode: "OPERATION_DEADLINE_EXCEEDED" });
        return true;
      },
    );
    assert.equal(revisionCalls(), 2);
    assert.equal(fetchCalls, 0);
  });
});

test("sendDraft rejects every Microsoft revision change before POST", async () => {
  const reviewedRaw = plainTextMime("Reviewed body");
  const reviewed = sendReview({
    draftId: "draft-revision",
    threadId: "thread-revision",
    body: "Reviewed body",
    raw: reviewedRaw,
    changeKey: "CQAAABYAA-before",
    lastModifiedDateTime: "2026-08-21T14:00:00Z",
  });
  const approvedManifest = fullManifest(reviewed);
  const changes = [
    { name: "message identity", patch: { id: "different-message" } },
    { name: "thread identity", patch: { conversationId: "different-thread" } },
    { name: "change key", patch: { changeKey: "CQAAABYAA-after" } },
    {
      name: "last modified time",
      patch: { lastModifiedDateTime: "2026-08-21T14:00:01Z" },
    },
    { name: "raw MIME payload", raw: plainTextMime("Changed body") },
    { name: "draft state", patch: { isDraft: false } },
  ];

  for (const scenario of changes) {
    const mail = provider();
    let postCalls = 0;
    mail.graphRequest = async (_account, path, options = {}) => {
      if (options.method === "POST") {
        postCalls += 1;
        return null;
      }
      if (path === rawPath("draft-revision")) return scenario.raw || reviewedRaw;
      if (path === attachmentPath("draft-revision")) {
        return scenario.attachments || { value: [] };
      }
      if (path === revisionPath("draft-revision")) {
        return {
          id: "draft-revision",
          conversationId: "thread-revision",
          isDraft: true,
          changeKey: "CQAAABYAA-before",
          lastModifiedDateTime: "2026-08-21T14:00:00Z",
          ...scenario.patch,
        };
      }
      throw new Error(`Unexpected Graph request: ${path}`);
    };

    await assert.rejects(
      mail.sendDraft(account, "draft-revision", approvedManifest),
      (error) => error.code === "DRAFT_CHANGED",
      scenario.name,
    );
    assert.equal(postCalls, 0, scenario.name);
  }
});

test("sendDraft rejects an attachment added after approval before POST", async () => {
  const mail = provider();
  const raw = plainTextMime("Reviewed body");
  const approvedManifest = fullManifest(sendReview({
    draftId: "draft-attachment-race",
    threadId: "thread-attachment-race",
    body: "Reviewed body",
    raw,
    changeKey: "CQAAABYAA-attachment-race",
    lastModifiedDateTime: "2026-08-21T15:00:00Z",
  }));
  let postCalls = 0;
  mail.graphRequest = async (_account, path, options = {}) => {
    if (options.method === "POST") {
      postCalls += 1;
      return null;
    }
    if (path === rawPath("draft-attachment-race")) return raw;
    if (path === attachmentPath("draft-attachment-race")) {
      return { value: [{ id: "attachment-added-after-review", isInline: false }] };
    }
    if (path === revisionPath("draft-attachment-race")) {
      return {
        id: "draft-attachment-race",
        conversationId: "thread-attachment-race",
        isDraft: true,
        changeKey: "CQAAABYAA-attachment-race",
        lastModifiedDateTime: "2026-08-21T15:00:00Z",
      };
    }
    throw new Error(`Unexpected Graph request: ${path}`);
  };

  await assert.rejects(
    mail.sendDraft(account, "draft-attachment-race", approvedManifest),
    { code: "DRAFT_CHANGED" },
  );
  assert.equal(postCalls, 0);
});

test("sendDraft fails closed when no expected revision is supplied", async () => {
  const mail = provider();
  let calls = 0;
  mail.graphRequest = async (_account, path, options = {}) => {
    calls += 1;
    assert.equal(path, "me/messages/draft-legacy/send");
    assert.equal(options.method, "POST");
    return null;
  };

  await assert.rejects(mail.sendDraft(account, "draft-legacy"), {
    code: "DRAFT_CHANGED",
  });
  assert.equal(calls, 0);
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

test("Microsoft authorization keeps browser success neutral until identity and Keychain verification", async () => {
  const mailConfig = config();
  const credentialStore = new MemoryCredentialStore();
  const events = [];
  const serialized = JSON.stringify({ Account: { verified: true }, AccessToken: {} });
  const originalSet = credentialStore.set.bind(credentialStore);
  credentialStore.set = async (...args) => {
    events.push("keychain-set");
    await originalSet(...args);
  };
  let interactiveRequest;
  let opened;
  const mail = new MicrosoftProvider({
    config: mailConfig,
    credentialStore,
    browserOpener: async (url, browser) => {
      opened = { url, browser };
    },
  });
  mail.createApplication = () => ({
    async acquireTokenInteractive(request) {
      interactiveRequest = request;
      await request.openBrowser("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
      return {
        accessToken: "not-a-real-token",
        scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
        tenantId: "tenant-id",
        account: { homeAccountId: "home-account-id" },
      };
    },
    getTokenCache() {
      return { serialize: () => serialized };
    },
  });
  mail.graphRequestWithToken = async () => {
    events.push("identity-verified");
    return {
      id: "user-1",
      displayName: "Sales",
      mail: "sales@example.com",
      userPrincipalName: "sales@example.com",
    };
  };

  const result = await mail.authorize(account, {
    browser: "safari",
    onInstruction: () => {},
  });

  assert.equal(opened.browser, "safari");
  assert.match(opened.url, /^https:\/\/login\.microsoftonline\.com\//u);
  assert.equal(interactiveRequest.loginHint, account.email);
  assert.equal(interactiveRequest.prompt, "select_account");
  assert.deepEqual(interactiveRequest.scopes, ["User.Read", "Mail.ReadWrite", "Mail.Send"]);
  assert.match(interactiveRequest.successTemplate, /authorization is not complete/iu);
  assert.doesNotMatch(interactiveRequest.successTemplate, /authorization (?:is )?complete/iu);
  assert.deepEqual(events, ["identity-verified", "keychain-set"]);
  assert.equal(
    await credentialStore.get(credentialAccountKey(mailConfig, account, ":msal-cache")),
    serialized,
  );
  assert.equal(result.email, account.email);
});

test("failed Microsoft Keychain verification restores the previous healthy credential", async () => {
  const mailConfig = config();
  const key = credentialAccountKey(mailConfig, account, ":msal-cache");
  const previousCredential = JSON.stringify({
    Account: { previous: true },
    AccessToken: { previous: true },
  });
  const replacementCredential = JSON.stringify({
    Account: { replacement: true },
    AccessToken: { replacement: true },
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

  const mail = new MicrosoftProvider({ config: mailConfig, credentialStore });
  mail.createApplication = () => ({
    async acquireTokenInteractive() {
      return {
        accessToken: "replacement-access-token",
        scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
      };
    },
    getTokenCache() {
      return { serialize: () => replacementCredential };
    },
  });
  mail.graphRequestWithToken = async () => ({
    id: "user-1",
    displayName: "Sales",
    mail: account.email,
    userPrincipalName: account.email,
  });

  await assert.rejects(
    mail.authorize(account, { onInstruction: () => {} }),
    { code: "KEYCHAIN_WRITE_FAILED" },
  );
  assert.equal(await credentialStore.get(key), previousCredential);

  mail.createApplication = () => ({
    async getAllAccounts() {
      return [{ username: account.email }];
    },
    async acquireTokenSilent() {
      return {
        accessToken: "previous-access-token",
        scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
      };
    },
  });
  const diagnostic = await mail.diagnose(account);
  assert.equal(diagnostic.status, "ok");
  assert.equal(diagnostic.credential_present, true);
  assert.equal(diagnostic.token_valid, true);
  assert.equal(diagnostic.scopes_valid, true);
  assert.equal(diagnostic.identity_verified, true);
});

test("Microsoft doctor distinguishes runtime, reauthorization, provider, and policy failures", async (context) => {
  const scenarios = [
    {
      name: "SDK TypeError is a runtime failure",
      error: new TypeError("SDK method shape changed"),
      status: "runtime_error",
      errorCode: "OAUTH_RUNTIME_ERROR",
      tokenValid: null,
    },
    {
      name: "explicit invalid_grant requires reauthorization",
      error: Object.assign(new Error("grant rejected"), { errorCode: "invalid_grant" }),
      status: "reauthorization_required",
      errorCode: "REAUTHENTICATION_REQUIRED",
      tokenValid: false,
    },
    {
      name: "network failure keeps the credential",
      error: Object.assign(new Error("network unavailable"), { code: "MICROSOFT_NETWORK_ERROR" }),
      status: "provider_unavailable",
      errorCode: "MICROSOFT_NETWORK_ERROR",
      tokenValid: null,
    },
    {
      name: "tenant policy is not a reauthorization prompt",
      error: Object.assign(new Error("admin consent required"), {
        errorCode: "admin_consent_required",
      }),
      status: "provider_policy_blocked",
      errorCode: "OAUTH_PROVIDER_POLICY_BLOCKED",
      tokenValid: null,
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const mailConfig = config();
      const key = credentialAccountKey(mailConfig, account, ":msal-cache");
      const credentialStore = new MemoryCredentialStore({
        [key]: JSON.stringify({ Account: { present: true }, AccessToken: {} }),
      });
      const mail = new MicrosoftProvider({ config: mailConfig, credentialStore });
      mail.createApplication = () => ({
        async getAllAccounts() {
          return [{ username: account.email }];
        },
        async acquireTokenSilent() {
          throw scenario.error;
        },
      });

      const diagnostic = await mail.diagnose(account);

      assert.equal(diagnostic.status, scenario.status);
      assert.equal(diagnostic.error_code, scenario.errorCode);
      assert.equal(diagnostic.token_valid, scenario.tokenValid);
      assert.equal(await credentialStore.get(key) !== null, true);
    });
  }
});
