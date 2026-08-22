import assert from "node:assert/strict";
import test from "node:test";
import { emptyConfig, validateConfig } from "../src/config.mjs";
import { MemoryCredentialStore } from "../src/keychain.mjs";
import { MailService } from "../src/mail-service.mjs";
import { SendApprovalStore } from "../src/send-approval.mjs";

function config() {
  const value = emptyConfig();
  value.safety.maxWriteBatch = 2;
  value.safety.maxRecipients = 2;
  value.accounts = [{ alias: "work", email: "owner@example.com", provider: "google" }];
  return validateConfig(value);
}

function draft(overrides = {}) {
  return {
    account: "work",
    draftId: "draft-1",
    messageId: "message-1",
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject: "Status",
    body: "Ready to send.",
    ...overrides,
  };
}

function harness({ initialDraft = draft(), sendError = null } = {}) {
  const calls = {
    archive: 0,
    createDraft: 0,
    createReplyDraft: 0,
    diagnose: 0,
    reviewDraft: 0,
    requestApproval: 0,
    sendDraft: 0,
  };
  let currentDraft = structuredClone(initialDraft);
  const provider = {
    async isAuthenticated() {
      return true;
    },
    async getMessage(_account, id) {
      return { id };
    },
    async createDraft(_account, input) {
      calls.createDraft += 1;
      return { input };
    },
    async createReplyDraft(_account, input) {
      calls.createReplyDraft += 1;
      return { input };
    },
    async diagnose(account) {
      calls.diagnose += 1;
      return {
        alias: account.alias,
        provider: account.provider,
        credential_present: true,
        token_valid: true,
        scopes_valid: true,
        identity_verified: true,
        status: "ok",
      };
    },
    async archive(_account, ids) {
      calls.archive += 1;
      return { archived: ids.length };
    },
    async reviewDraft() {
      calls.reviewDraft += 1;
      return structuredClone(currentDraft);
    },
    async sendDraft() {
      calls.sendDraft += 1;
      if (sendError) throw sendError;
      return { status: "sent", sentMessageId: "sent-1" };
    },
  };
  const approvalStore = new SendApprovalStore({
    ttlSeconds: config().safety.sendApprovalTtlSeconds,
  });
  const approvalUi = {
    async requestApproval(requestId) {
      calls.requestApproval += 1;
      return { url: `http://127.0.0.1:45678/review/${requestId}` };
    },
  };
  const service = new MailService({
    config: config(),
    credentialStore: new MemoryCredentialStore(),
    approvalStore,
    approvalUi,
    providers: { google: provider },
  });
  return {
    approvalStore,
    calls,
    provider,
    service,
    changeDraft(patch) {
      currentDraft = { ...currentDraft, ...patch };
    },
    approve(prepared) {
      const pending = approvalStore.getPendingReview(prepared.approvalRequestId);
      return approvalStore.approveOutOfBand(
        prepared.approvalRequestId,
        pending.fingerprint,
      );
    },
  };
}

test("every operation requires a known explicit account alias", async () => {
  const { calls, service } = harness();

  await assert.rejects(service.getMessage(undefined, "message-1"), {
    code: "UNKNOWN_ACCOUNT",
  });
  await assert.rejects(service.getMessage("missing", "message-1"), {
    code: "UNKNOWN_ACCOUNT",
  });
  assert.equal(calls.reviewDraft, 0);
});

test("account listing distinguishes credential presence from verified health", async () => {
  const { service } = harness();

  assert.deepEqual(await service.listAccounts(), [
    {
      alias: "work",
      email: "owner@example.com",
      provider: "google",
      credentialPresent: true,
      connectionStatus: "credential_present_unverified",
    },
  ]);
});

test("connection diagnostics are read-only and remain labeled by account alias", async () => {
  const { calls, service } = harness();

  const diagnostics = await service.diagnoseAccounts("work");

  assert.deepEqual(diagnostics, [
    {
      alias: "work",
      provider: "google",
      credential_present: true,
      token_valid: true,
      scopes_valid: true,
      identity_verified: true,
      status: "ok",
    },
  ]);
  assert.equal(calls.diagnose, 1);
  assert.equal(calls.createDraft, 0);
  assert.equal(calls.sendDraft, 0);
});

test("write batch and total recipient limits stop calls before the provider", async () => {
  const { calls, service } = harness();

  await assert.rejects(service.archive("work", ["one", "two", "three"]), {
    code: "SAFETY_LIMIT",
  });
  await assert.rejects(
    service.createDraft("work", {
      to: ["one@example.com", "two@example.com"],
      cc: ["three@example.com"],
      body: "Too many recipients",
    }),
    { code: "SAFETY_LIMIT" },
  );
  assert.equal(calls.archive, 0);
  assert.equal(calls.createDraft, 0);
});

test("reply-draft input is bounded, normalized, and passed without a send", async () => {
  const { calls, service } = harness();

  const result = await service.createReplyDraft("work", {
    messageId: "original-1",
    body: "Reply body",
    cc: [" Copy@Example.COM "],
    bcc: [],
  });

  assert.deepEqual(result.input, {
    messageId: "original-1",
    body: "Reply body",
    cc: ["copy@example.com"],
    bcc: [],
  });
  assert.equal(calls.createReplyDraft, 1);
  assert.equal(calls.sendDraft, 0);
});

test("prepare opens the full local review without exposing its URL or full body to MCP", async () => {
  const fullBody = `${"A".repeat(5_000)}\nCOMPLETE ENDING`;
  const { approvalStore, calls, service } = harness({
    initialDraft: draft({ body: fullBody }),
  });
  const prepared = await service.reviewDraft("work", "draft-1");

  assert.equal(prepared.body, undefined);
  assert.equal(prepared.approvalUrl, undefined);
  assert.equal(prepared.bodyPreviewTruncated, true);
  assert.match(prepared.bodyPreview, /\[preview truncated\]$/u);
  assert.doesNotMatch(prepared.bodyPreview, /COMPLETE ENDING/u);
  assert.equal(prepared.bodyBytes, Buffer.byteLength(fullBody));
  assert.equal(prepared.approvalToken, undefined);
  assert.match(prepared.approvalRequestId, /^sar_/u);
  assert.equal(prepared.approvalWindowOpened, true);
  assert.equal(prepared.approvalStatus, "pending_human_approval");
  assert.equal(calls.requestApproval, 1);
  assert.equal(
    approvalStore.getPendingReview(prepared.approvalRequestId).review.body,
    fullBody,
  );
  assert.equal(calls.sendDraft, 0);
});

test("send fails before out-of-band approval and succeeds only after it", async () => {
  const { approve, calls, service } = harness();
  const prepared = await service.reviewDraft("work", "draft-1");

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
  assert.equal(calls.sendDraft, 0);
  assert.equal(calls.reviewDraft, 1);

  approve(prepared);
  const sent = await service.sendDraft("work", "draft-1", prepared.approvalRequestId);
  assert.equal(sent.status, "sent");
  assert.equal(calls.sendDraft, 1);
});

test("a draft changed after human approval is rejected before provider send", async () => {
  const { approve, calls, changeDraft, service } = harness();
  const prepared = await service.reviewDraft("work", "draft-1");
  approve(prepared);
  changeDraft({ body: "Changed after the user reviewed it." });

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "DRAFT_CHANGED" },
  );
  assert.equal(calls.sendDraft, 0);
});

test("a provider draft message identity change invalidates human approval", async () => {
  const { approve, calls, changeDraft, service } = harness();
  const prepared = await service.reviewDraft("work", "draft-1");
  approve(prepared);
  changeDraft({ messageId: "message-2" });

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "DRAFT_CHANGED" },
  );
  assert.equal(calls.sendDraft, 0);
});

test("a matching approval sends once and its request cannot be reused", async () => {
  const { approve, calls, service } = harness();
  const prepared = await service.reviewDraft("work", "draft-1");
  approve(prepared);

  const sent = await service.sendDraft("work", "draft-1", prepared.approvalRequestId);
  assert.equal(sent.status, "sent");
  assert.equal(calls.sendDraft, 1);

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
  assert.equal(calls.sendDraft, 1);
});

test("provider send failure becomes unknown status and is never retried", async (context) => {
  context.mock.method(console, "error", () => {});
  const { approve, calls, service } = harness({ sendError: new Error("simulated timeout") });
  const prepared = await service.reviewDraft("work", "draft-1");
  approve(prepared);

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    (error) =>
      error.code === "SEND_STATUS_UNKNOWN" &&
      error.details.account === "work" &&
      error.details.draftId === "draft-1",
  );
  assert.equal(calls.sendDraft, 1);

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
  assert.equal(calls.sendDraft, 1);
});
