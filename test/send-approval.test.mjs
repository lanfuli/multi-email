import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SendApprovalStore, stableDraftFingerprint } from "../src/send-approval.mjs";

function review(overrides = {}) {
  const body = overrides.body ?? "Ready to go.";
  return {
    manifestVersion: 1,
    policyVersion: 2,
    account: "work",
    provider: "google",
    authenticatedPrincipal: "owner@example.com",
    mailboxResource: "owner@example.com",
    draftId: "draft-1",
    messageId: "message-1",
    threadId: "thread-1",
    from: "owner@example.com",
    sender: "",
    replyTo: [],
    to: ["person@example.com"],
    cc: [],
    bcc: [],
    subject: "Status",
    inReplyTo: "",
    references: "",
    body,
    bodyFormat: "text",
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    attachments: [],
    completeness: "complete",
    providerRevision: {
      messageId: "message-1",
      threadId: "thread-1",
      rawPayloadSha256: "a".repeat(64),
      changeKey: null,
      lastModifiedDateTime: null,
    },
    ...overrides,
  };
}

test("preparing a review does not authorize sending", () => {
  const store = new SendApprovalStore();
  const draft = review();
  const prepared = store.prepare(draft);

  assert.match(prepared.requestId, /^sar_[A-Za-z0-9_-]+$/u);
  assert.equal(Number.isNaN(Date.parse(prepared.expiresAt)), false);
  assert.throws(
    () => store.consumeApproved(prepared.requestId, draft),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("trusted review access contains the complete immutable body", () => {
  const store = new SendApprovalStore();
  const fullBody = `${"A".repeat(5_000)}\nTHE END`;
  const draft = review({
    body: fullBody,
    attachments: [{ name: "blocked.txt", metadata: { size: 7 } }],
  });
  const { requestId } = store.prepare(draft);
  draft.body = "mutated caller object";
  draft.to.push("mutated@example.com");
  draft.attachments[0].metadata.size = 999;
  draft.providerRevision.rawPayloadSha256 = "b".repeat(64);

  const pending = store.getPendingReview(requestId);
  assert.equal(pending.review.body, fullBody);
  assert.equal(pending.review.body.endsWith("THE END"), true);
  assert.deepEqual(pending.review.to, ["person@example.com"]);
  assert.equal(pending.review.attachments[0].metadata.size, 7);
  assert.equal(pending.review.providerRevision.rawPayloadSha256, "a".repeat(64));

  pending.review.body = "mutated returned object";
  pending.review.attachments[0].metadata.size = 123;
  pending.review.providerRevision.rawPayloadSha256 = "c".repeat(64);
  assert.equal(store.getPendingReview(requestId).review.body, fullBody);
  assert.equal(store.getPendingReview(requestId).review.attachments[0].metadata.size, 7);
  assert.equal(
    store.getPendingReview(requestId).review.providerRevision.rawPayloadSha256,
    "a".repeat(64),
  );
});

test("out-of-band approval enables exactly one matching send", () => {
  const store = new SendApprovalStore();
  const draft = review();
  const { requestId } = store.prepare(draft);
  const pending = store.getPendingReview(requestId);

  const approved = store.approveOutOfBand(requestId, pending.fingerprint);
  assert.equal(approved.status, "approved");
  assert.equal(store.consumeApproved(requestId, draft), true);
  assert.throws(
    () => store.consumeApproved(requestId, draft),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("out-of-band approval requires the exact reviewed fingerprint", () => {
  const store = new SendApprovalStore();
  const { requestId } = store.prepare(review());

  assert.throws(
    () => store.approveOutOfBand(requestId, "0".repeat(64)),
    { code: "SEND_APPROVAL_MISMATCH" },
  );
  assert.equal(store.getPendingReview(requestId).status, "pending");
});

test("an approved request cannot be used for another account or draft", () => {
  const store = new SendApprovalStore();
  const draft = review();
  const { requestId } = store.prepare(draft);
  const pending = store.getPendingReview(requestId);
  store.approveOutOfBand(requestId, pending.fingerprint);

  assert.throws(
    () => store.consumeApproved(requestId, review({ account: "personal" })),
    { code: "SEND_APPROVAL_MISMATCH" },
  );
  assert.throws(
    () => store.consumeApproved(requestId, draft),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("an approval expires before or after the human decision", () => {
  let now = 1_000;
  const beforeApproval = new SendApprovalStore({ ttlSeconds: 5, clock: () => now });
  const first = beforeApproval.prepare(review());
  now += 5_001;
  assert.throws(
    () => beforeApproval.getPendingReview(first.requestId),
    { code: "SEND_APPROVAL_EXPIRED" },
  );

  now = 10_000;
  const afterApproval = new SendApprovalStore({ ttlSeconds: 5, clock: () => now });
  const second = afterApproval.prepare(review());
  const pending = afterApproval.getPendingReview(second.requestId);
  afterApproval.approveOutOfBand(second.requestId, pending.fingerprint);
  now += 5_001;
  assert.throws(
    () => afterApproval.consumeApproved(second.requestId, review()),
    { code: "SEND_APPROVAL_EXPIRED" },
  );
});

test("a post-approval draft change spends and invalidates the request", () => {
  const store = new SendApprovalStore();
  const draft = review();
  const { requestId } = store.prepare(draft);
  const pending = store.getPendingReview(requestId);
  store.approveOutOfBand(requestId, pending.fingerprint);

  assert.throws(
    () => store.consumeApproved(requestId, review({ body: "Changed after review." })),
    { code: "DRAFT_CHANGED" },
  );
  assert.throws(
    () => store.consumeApproved(requestId, draft),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("approval fingerprint is bound to every effective-send manifest field", () => {
  const changes = [
    { manifestVersion: 2 },
    { policyVersion: 3 },
    { provider: "microsoft" },
    { authenticatedPrincipal: "other@example.com" },
    { mailboxResource: "shared@example.com" },
    { messageId: "message-2" },
    { threadId: "thread-2" },
    { from: "other@example.com" },
    { sender: "owner@example.com" },
    { replyTo: ["reply@example.com"] },
    { to: ["other@example.com"] },
    { cc: ["copy@example.com"] },
    { bcc: ["audit@example.com"] },
    { subject: "A different subject" },
    { inReplyTo: "<original@example.com>" },
    { references: "<root@example.com> <original@example.com>" },
    { body: "A different body" },
    { bodyFormat: "html" },
    { bodySha256: "f".repeat(64) },
    { attachments: [{ name: "file.txt" }] },
    { completeness: "partial" },
    {
      providerRevision: {
        messageId: "message-2",
        threadId: "thread-1",
        rawPayloadSha256: "a".repeat(64),
        changeKey: null,
        lastModifiedDateTime: null,
      },
    },
    {
      providerRevision: {
        messageId: "message-1",
        threadId: "thread-2",
        rawPayloadSha256: "a".repeat(64),
        changeKey: null,
        lastModifiedDateTime: null,
      },
    },
    {
      providerRevision: {
        messageId: "message-1",
        threadId: "thread-1",
        rawPayloadSha256: "b".repeat(64),
        changeKey: null,
        lastModifiedDateTime: null,
      },
    },
    {
      providerRevision: {
        messageId: "message-1",
        threadId: "thread-1",
        rawPayloadSha256: null,
        changeKey: "change-2",
        lastModifiedDateTime: "2026-08-22T00:00:00Z",
      },
    },
  ];

  for (const change of changes) {
    const store = new SendApprovalStore();
    const original = review();
    const { requestId } = store.prepare(original);
    const pending = store.getPendingReview(requestId);
    store.approveOutOfBand(requestId, pending.fingerprint);
    assert.throws(
      () => store.consumeApproved(requestId, review(change)),
      { code: "DRAFT_CHANGED" },
    );
  }
});

test("out-of-band rejection permanently removes the request", () => {
  const store = new SendApprovalStore();
  const { requestId } = store.prepare(review());
  assert.equal(store.rejectOutOfBand(requestId).status, "rejected");
  assert.throws(
    () => store.getPendingReview(requestId),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("recipient ordering does not change the stable fingerprint", () => {
  const first = review({ to: ["b@example.com", "a@example.com"] });
  const second = review({ to: ["a@example.com", "b@example.com"] });
  assert.equal(stableDraftFingerprint(first), stableDraftFingerprint(second));
});

test("send approval TTL cannot exceed the non-configurable hard limit", () => {
  assert.throws(
    () => new SendApprovalStore({ ttlSeconds: 301 }),
    { code: "INVALID_CONFIG" },
  );
  assert.doesNotThrow(() => new SendApprovalStore({ ttlSeconds: 300 }));
});
