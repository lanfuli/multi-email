import assert from "node:assert/strict";
import test from "node:test";
import { SendApprovalStore } from "../src/send-approval.mjs";
import { LocalSendApprovalUi } from "../src/send-approval-ui.mjs";

function review(overrides = {}) {
  return {
    account: "work",
    draftId: "draft-1",
    messageId: "message-1",
    to: ["recipient@example.com"],
    cc: ["copy@example.com"],
    bcc: ["audit@example.com"],
    subject: "Status <review>",
    body: "Ready to go.",
    ...overrides,
  };
}

function hiddenValue(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`, "u"));
  assert.ok(match, `missing hidden field ${name}`);
  return match[1];
}

function formAction(html) {
  const match = html.match(/<form method="post" action="([^"]+)"/u);
  assert.ok(match, "missing approval form action");
  return match[1];
}

async function loadReview(url) {
  const response = await fetch(url);
  const html = await response.text();
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "review response did not set its approval cookie");
  return {
    response,
    html,
    cookie: setCookie.split(";", 1)[0],
    csrf: hiddenValue(html, "csrf"),
    fingerprint: hiddenValue(html, "fingerprint"),
    action: formAction(html),
  };
}

test("localhost UI renders the full escaped review and approves one exact send", async (context) => {
  const body = `${"A".repeat(5_000)}\n</pre><script>bad()</script>\nFULL_BODY_END`;
  const store = new SendApprovalStore();
  const prepared = store.prepare(review({ body }));
  let openedUrl;
  const ui = new LocalSendApprovalUi({
    approvalStore: store,
    browserOpener: async (url) => {
      openedUrl = url;
    },
  });
  context.after(() => ui.stop());

  const local = await ui.requestApproval(prepared.requestId);
  assert.equal(local.url, openedUrl);
  assert.match(local.url, /^http:\/\/127\.0\.0\.1:\d+\/review\//u);

  const page = await loadReview(local.url);
  assert.equal(page.response.status, 200);
  assert.match(page.response.headers.get("cache-control"), /no-store/u);
  assert.match(page.response.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.match(page.response.headers.get("x-frame-options"), /DENY/u);
  assert.match(page.html, /FULL_BODY_END/u);
  assert.match(page.html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/u);
  assert.doesNotMatch(page.html, /<script>bad\(\)<\/script>/u);

  const origin = new URL(local.url).origin;
  const decision = await fetch(new URL(page.action, origin), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: page.cookie,
      origin,
    },
    body: new URLSearchParams({
      csrf: page.csrf,
      fingerprint: page.fingerprint,
      decision: "approve",
    }),
  });
  assert.equal(decision.status, 200);
  assert.match(await decision.text(), /One send is now enabled/u);
  assert.equal(store.consumeApproved(prepared.requestId, review({ body })), true);
  assert.throws(
    () => store.consumeApproved(prepared.requestId, review({ body })),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("localhost UI rejects cross-origin and nonce-less approval posts", async (context) => {
  const store = new SendApprovalStore();
  const prepared = store.prepare(review());
  const ui = new LocalSendApprovalUi({
    approvalStore: store,
    browserOpener: async () => {},
  });
  context.after(() => ui.stop());

  const local = await ui.requestApproval(prepared.requestId);
  const page = await loadReview(local.url);
  const origin = new URL(local.url).origin;
  const endpoint = new URL(page.action, origin);
  const validBody = new URLSearchParams({
    csrf: page.csrf,
    fingerprint: page.fingerprint,
    decision: "approve",
  });

  const crossOrigin = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: page.cookie,
      origin: "https://attacker.example",
    },
    body: validBody,
  });
  assert.equal(crossOrigin.status, 403);

  const wrongNonce = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: page.cookie,
      origin,
    },
    body: new URLSearchParams({
      csrf: "wrong",
      fingerprint: page.fingerprint,
      decision: "approve",
    }),
  });
  assert.equal(wrongNonce.status, 403);
  assert.equal(store.getPendingReview(prepared.requestId).status, "pending");
  assert.throws(
    () => store.consumeApproved(prepared.requestId, review()),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("localhost UI rejection removes the send request", async (context) => {
  const store = new SendApprovalStore();
  const prepared = store.prepare(review());
  const ui = new LocalSendApprovalUi({
    approvalStore: store,
    browserOpener: async () => {},
  });
  context.after(() => ui.stop());

  const local = await ui.requestApproval(prepared.requestId);
  const page = await loadReview(local.url);
  const origin = new URL(local.url).origin;
  const rejected = await fetch(new URL(page.action, origin), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: page.cookie,
      origin,
    },
    body: new URLSearchParams({
      csrf: page.csrf,
      fingerprint: page.fingerprint,
      decision: "reject",
    }),
  });
  assert.equal(rejected.status, 200);
  assert.match(await rejected.text(), /will not be sent/u);
  assert.throws(
    () => store.getPendingReview(prepared.requestId),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});
