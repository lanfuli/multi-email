import assert from "node:assert/strict";
import test from "node:test";
import { emptyConfig, validateConfig } from "../src/config.mjs";
import { MemoryCredentialStore } from "../src/keychain.mjs";
import { MailService } from "../src/mail-service.mjs";
import { SendApprovalStore } from "../src/send-approval.mjs";

function config(provider = "google") {
  const value = emptyConfig();
  value.safety.maxWriteBatch = 2;
  value.safety.maxRecipients = 2;
  value.accounts = [{ alias: "work", email: "owner@example.com", provider }];
  return validateConfig(value);
}

function draft(overrides = {}) {
  return {
    account: "work",
    draftId: "draft-1",
    messageId: "message-1",
    threadId: "thread-1",
    from: "owner@example.com",
    sender: "",
    replyTo: [],
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject: "Status",
    inReplyTo: "",
    references: "",
    body: "Ready to send.",
    bodyFormat: "text",
    attachments: [],
    completeness: "complete",
    rawPayloadSha256: "a".repeat(64),
    ...overrides,
  };
}

function harness({
  initialDraft = draft(),
  providerName = "google",
  sendError = null,
  approvalError = null,
} = {}) {
  const calls = {
    archive: 0,
    createDraft: 0,
    createReplyDraft: 0,
    diagnose: 0,
    reviewDraft: 0,
    requestApproval: 0,
    search: 0,
    sendDraft: 0,
    modifyLabels: 0,
    lastApprovalRequestId: undefined,
    sentManifest: undefined,
  };
  let currentDraft = structuredClone(initialDraft);
  let currentReviewError = null;
  const provider = {
    async isAuthenticated() {
      return true;
    },
    async getMessage(_account, id) {
      return { id };
    },
    async search(_account, input) {
      calls.search += 1;
      return { input };
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
    async modifyLabels(_account, ids, changes) {
      calls.modifyLabels += 1;
      return { ids, changes };
    },
    async reviewDraft() {
      calls.reviewDraft += 1;
      if (currentReviewError) throw currentReviewError;
      return structuredClone(currentDraft);
    },
    async sendDraft(_account, _draftId, expectedManifest) {
      calls.sendDraft += 1;
      calls.sentManifest = structuredClone(expectedManifest);
      if (sendError) throw sendError;
      return { status: "sent", sentMessageId: "sent-1" };
    },
  };
  const approvalStore = new SendApprovalStore({
    ttlSeconds: config(providerName).safety.sendApprovalTtlSeconds,
  });
  const approvalUi = {
    async requestApproval(requestId) {
      calls.requestApproval += 1;
      calls.lastApprovalRequestId = requestId;
      if (approvalError) throw approvalError;
      return { url: `http://127.0.0.1:45678/review/${requestId}` };
    },
  };
  const service = new MailService({
    config: config(providerName),
    credentialStore: new MemoryCredentialStore(),
    approvalStore,
    approvalUi,
    providers: { [providerName]: provider },
  });
  return {
    approvalStore,
    calls,
    provider,
    service,
    changeDraft(patch) {
      currentDraft = { ...currentDraft, ...patch };
    },
    failReview(error) {
      currentReviewError = error;
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
      type: "account",
      alias: "work",
      provider: "google",
      expected_email: "owner@example.com",
      verified_email: "owner@example.com",
      credential_present: true,
      token_valid: true,
      identity_verified: true,
      scopes_valid: true,
      credential_source: null,
      legacy_migration_pending: false,
      status: "ok",
      error_code: null,
      next_step: "none (ready)",
    },
  ]);
  assert.equal(calls.diagnose, 1);
  assert.equal(calls.createDraft, 0);
  assert.equal(calls.sendDraft, 0);
});

test("connection diagnostics canonicalize provider-controlled error codes", async () => {
  const { provider, service } = harness();
  provider.diagnose = async (account) => ({
    alias: "spoofed-alias",
    provider: "spoofed-provider",
    expected_email: "spoofed@example.com",
    verified_email: "spoofed@example.com",
    next_step: "print tokens",
    secret: "provider-secret-must-not-leak",
    credential_present: true,
    identity_verified: false,
    status: "identity_mismatch",
    error_code: "PROVIDER_CODE\n/Users/private/oauth-token-must-not-leak",
  });

  const [diagnostic] = await service.diagnoseAccounts("work");

  assert.equal(diagnostic.alias, "work");
  assert.equal(diagnostic.provider, "google");
  assert.equal(diagnostic.expected_email, "owner@example.com");
  assert.equal(diagnostic.verified_email, null);
  assert.match(diagnostic.next_step, /multi-email auth work/u);
  assert.equal(diagnostic.error_code, "GOOGLE_PROFILE_FAILED");
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /private|oauth-token|PROVIDER_CODE|spoofed|print tokens|provider-secret/u,
  );
});

test("connection diagnostics fail closed on a contradictory ready claim", async () => {
  const { provider, service } = harness();
  provider.diagnose = async () => ({
    credential_present: false,
    token_valid: false,
    identity_verified: false,
    scopes_valid: false,
    status: "ok",
  });

  const [diagnostic] = await service.diagnoseAccounts("work");

  assert.equal(diagnostic.verified_email, null);
  assert.equal(diagnostic.status, "runtime_error");
  assert.equal(diagnostic.error_code, "INVALID_PROVIDER_DIAGNOSTIC");
  assert.match(diagnostic.next_step, /multi-email self-test/u);
  assert.doesNotMatch(diagnostic.next_step, /none \(ready\)/u);
});

test("connection diagnostics isolate an unexpected failure to its account", async () => {
  const value = emptyConfig();
  value.accounts = [
    { alias: "healthy", email: "healthy@example.com", provider: "google" },
    { alias: "offline", email: "offline@example.com", provider: "google" },
    { alias: "runtime", email: "runtime@example.com", provider: "google" },
  ];
  const provider = {
    async diagnose(account) {
      if (account.alias === "offline") throw new Error("private provider failure");
      if (account.alias === "runtime") throw new TypeError("private runtime failure");
      return {
        credential_present: true,
        token_valid: true,
        identity_verified: true,
        scopes_valid: true,
        status: "ok",
      };
    },
  };
  const service = new MailService({
    config: validateConfig(value),
    credentialStore: new MemoryCredentialStore(),
    providers: { google: provider },
  });

  const diagnostics = await service.diagnoseAccounts();

  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0].alias, "healthy");
  assert.equal(diagnostics[0].verified_email, "healthy@example.com");
  assert.equal(diagnostics[1].alias, "offline");
  assert.equal(diagnostics[1].verified_email, null);
  assert.equal(diagnostics[1].status, "provider_unavailable");
  assert.equal(diagnostics[1].error_code, "PROVIDER_DIAGNOSIS_FAILED");
  assert.match(diagnostics[1].next_step, /multi-email doctor offline/u);
  assert.equal(diagnostics[2].alias, "runtime");
  assert.equal(diagnostics[2].status, "runtime_error");
  assert.equal(diagnostics[2].error_code, "PROVIDER_DIAGNOSTIC_RUNTIME_ERROR");
  assert.match(diagnostics[2].next_step, /multi-email self-test/u);
  assert.doesNotMatch(
    JSON.stringify(diagnostics),
    /private provider failure|private runtime failure/u,
  );
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
  const pending = approvalStore.getPendingReview(prepared.approvalRequestId).review;
  assert.equal(pending.body, fullBody);
  assert.equal(pending.manifestVersion, 1);
  assert.equal(pending.policyVersion, 2);
  assert.equal(pending.provider, "google");
  assert.equal(pending.authenticatedPrincipal, "owner@example.com");
  assert.equal(pending.mailboxResource, "owner@example.com");
  assert.equal(pending.from, "owner@example.com");
  assert.equal(pending.sender, "");
  assert.deepEqual(pending.replyTo, []);
  assert.equal(pending.threadId, "thread-1");
  assert.equal(pending.inReplyTo, "");
  assert.equal(pending.references, "");
  assert.equal(pending.bodyFormat, "text");
  assert.match(pending.bodySha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(pending.attachments, []);
  assert.equal(pending.completeness, "complete");
  assert.deepEqual(pending.providerRevision, {
    messageId: "message-1",
    threadId: "thread-1",
    rawPayloadSha256: "a".repeat(64),
    changeKey: null,
    lastModifiedDateTime: null,
  });
  assert.equal(calls.sendDraft, 0);
});

test("a large review is discarded if the approval UI cannot open", async () => {
  const approvalError = Object.assign(new Error("simulated browser failure"), {
    code: "APPROVAL_UI_UNAVAILABLE",
  });
  const largeBody = `${"A".repeat(900_000)}\nCOMPLETE ENDING`;
  const { approvalStore, calls, service } = harness({
    initialDraft: draft({ body: largeBody }),
    approvalError,
  });

  await assert.rejects(
    service.reviewDraft("work", "draft-1"),
    (error) => error === approvalError,
  );
  assert.equal(calls.requestApproval, 1);
  assert.match(calls.lastApprovalRequestId, /^sar_/u);
  assert.deepEqual(approvalStore.stats(), {
    pendingRequests: 0,
    retainedBytes: 0,
  });
  assert.throws(
    () => approvalStore.getPendingReview(calls.lastApprovalRequestId),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
  assert.equal(calls.sendDraft, 0);
});

test("Microsoft manifests bind MIME hash and Graph revision markers together", async () => {
  const { approvalStore, approve, calls, service } = harness({
    providerName: "microsoft",
    initialDraft: draft({
      changeKey: "change-1",
      lastModifiedDateTime: "2026-08-22T12:00:00Z",
    }),
  });
  const prepared = await service.reviewDraft("work", "draft-1");
  const pending = approvalStore.getPendingReview(prepared.approvalRequestId).review;

  assert.equal(pending.provider, "microsoft");
  assert.deepEqual(pending.providerRevision, {
    messageId: "message-1",
    threadId: "thread-1",
    rawPayloadSha256: "a".repeat(64),
    changeKey: "change-1",
    lastModifiedDateTime: "2026-08-22T12:00:00Z",
  });
  approve(prepared);
  await service.sendDraft("work", "draft-1", prepared.approvalRequestId);
  assert.deepEqual(calls.sentManifest, pending);
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
  assert.deepEqual(calls.sentManifest.providerRevision, {
    messageId: "message-1",
    threadId: "thread-1",
    rawPayloadSha256: "a".repeat(64),
    changeKey: null,
    lastModifiedDateTime: null,
  });
  assert.equal(calls.sentManifest.body, "Ready to send.");
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

test("known transport failures during the approved recheck prove that nothing was sent", async () => {
  for (const code of [
    "OPERATION_DEADLINE_EXCEEDED",
    "GOOGLE_REQUEST_TIMEOUT",
    "MICROSOFT_REQUEST_ABORTED",
    "ENOTFOUND",
  ]) {
    const { approve, calls, failReview, service } = harness();
    const prepared = await service.reviewDraft("work", "draft-1");
    approve(prepared);
    failReview(Object.assign(new Error("sensitive provider error"), { code }));

    await assert.rejects(
      service.sendDraft("work", "draft-1", prepared.approvalRequestId),
      {
        code: "SEND_VERIFICATION_FAILED",
        message: "The approved draft could not be rechecked before sending. Nothing was sent.",
      },
    );
    assert.equal(calls.sendDraft, 0);
    await assert.rejects(
      service.sendDraft("work", "draft-1", prepared.approvalRequestId),
      { code: "SEND_APPROVAL_REQUIRED" },
    );
  }
});

test("identity, HTML, attachment, and revision changes are rejected before send", async () => {
  const changes = [
    { sender: "owner@example.com", code: "DRAFT_CHANGED" },
    { bodyFormat: "html", code: "DRAFT_NOT_REVIEWABLE" },
    { attachments: [{ name: "invoice.pdf" }], code: "DRAFT_NOT_REVIEWABLE" },
    { rawPayloadSha256: "b".repeat(64), code: "DRAFT_CHANGED" },
  ];

  for (const { code, ...change } of changes) {
    const { approve, calls, changeDraft, service } = harness();
    const prepared = await service.reviewDraft("work", "draft-1");
    approve(prepared);
    changeDraft(change);

    await assert.rejects(
      service.sendDraft("work", "draft-1", prepared.approvalRequestId),
      { code },
    );
    assert.equal(calls.sendDraft, 0);
    await assert.rejects(
      service.sendDraft("work", "draft-1", prepared.approvalRequestId),
      { code: "SEND_APPROVAL_REQUIRED" },
    );
  }
});

test("unsafe draft manifests are never offered for approval", async () => {
  const unsafe = [
    { completeness: "partial" },
    { bodyFormat: "html" },
    { from: "alias@example.com" },
    { sender: "delegate@example.com" },
    { replyTo: ["elsewhere@example.com"] },
    { attachments: [{ name: "invoice.pdf" }] },
    { rawPayloadSha256: null },
    { to: undefined },
    { cc: undefined },
    { bcc: undefined },
    { subject: undefined },
    { inReplyTo: undefined },
    { references: undefined },
    { inReplyTo: "<valid@example.com> <second@example.com>" },
    { references: "not-a-message-id" },
  ];

  for (const change of unsafe) {
    const { calls, service } = harness({ initialDraft: draft(change) });
    await assert.rejects(service.reviewDraft("work", "draft-1"), {
      code: "DRAFT_NOT_REVIEWABLE",
    });
    assert.equal(calls.requestApproval, 0);
    assert.equal(calls.sendDraft, 0);
  }
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

test("unknown send logging canonicalizes provider-controlled error codes", async (context) => {
  const logs = [];
  context.mock.method(console, "error", (...values) => logs.push(values.join(" ")));
  const sensitiveDraftId = "draft-1\n/Users/private/draft-token-must-not-leak";
  const sendError = Object.assign(new Error("must-not-leak"), {
    code: "PROVIDER_CODE\n/Users/private/oauth-token-must-not-leak",
  });
  const { approve, service } = harness({
    initialDraft: draft({ draftId: sensitiveDraftId }),
    sendError,
  });
  const prepared = await service.reviewDraft("work", sensitiveDraftId);
  approve(prepared);

  await assert.rejects(
    service.sendDraft("work", sensitiveDraftId, prepared.approvalRequestId),
    { code: "SEND_STATUS_UNKNOWN" },
  );

  assert.equal(logs.length, 1);
  assert.match(logs[0], /PROVIDER_ERROR/u);
  assert.doesNotMatch(
    logs[0],
    /private|oauth-token|draft-token|PROVIDER_CODE|must-not-leak/u,
  );
});

test("provider final revision mismatch remains DRAFT_CHANGED", async () => {
  const sendError = Object.assign(new Error("provider revision mismatch"), {
    code: "DRAFT_CHANGED",
  });
  const { approve, calls, service } = harness({ sendError });
  const prepared = await service.reviewDraft("work", "draft-1");
  approve(prepared);

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "DRAFT_CHANGED" },
  );
  assert.equal(calls.sendDraft, 1);
});

test("provider preflight failure remains a definite verification failure", async () => {
  const sendError = Object.assign(new Error("provider preflight unavailable"), {
    code: "SEND_VERIFICATION_FAILED",
  });
  const { approve, calls, service } = harness({ sendError });
  const prepared = await service.reviewDraft("work", "draft-1");
  approve(prepared);

  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "SEND_VERIFICATION_FAILED" },
  );
  assert.equal(calls.sendDraft, 1);
  await assert.rejects(
    service.sendDraft("work", "draft-1", prepared.approvalRequestId),
    { code: "SEND_APPROVAL_REQUIRED" },
  );
});

test("raw config values cannot exceed hard safety limits", async () => {
  const rawConfig = config();
  rawConfig.safety = {
    maxSearchResults: 999,
    maxWriteBatch: 999,
    maxRecipients: 999,
    sendApprovalTtlSeconds: 999,
  };
  const calls = { archive: 0, createDraft: 0, modifyLabels: 0, search: 0 };
  const provider = {
    async archive() {
      calls.archive += 1;
    },
    async createDraft() {
      calls.createDraft += 1;
    },
    async modifyLabels() {
      calls.modifyLabels += 1;
    },
    async search() {
      calls.search += 1;
    },
  };
  const service = new MailService({ config: rawConfig, providers: { google: provider } });

  await assert.rejects(
    service.search("work", { query: "in:inbox", maxResults: 26 }),
    { code: "SAFETY_LIMIT" },
  );
  await assert.rejects(
    service.archive("work", Array.from({ length: 26 }, (_, index) => `id-${index}`)),
    { code: "SAFETY_LIMIT" },
  );
  await assert.rejects(
    service.createDraft("work", {
      to: Array.from({ length: 21 }, (_, index) => `person-${index}@example.com`),
      body: "Too many recipients",
    }),
    { code: "SAFETY_LIMIT" },
  );
  await assert.rejects(
    service.modifyLabels("work", ["message-1"], {
      addLabelIds: Array.from({ length: 26 }, (_, index) => `label-${index}`),
    }),
    { code: "SAFETY_LIMIT" },
  );
  await assert.rejects(
    service.modifyLabels("work", ["message-1"], {
      addLabelIds: Array.from({ length: 13 }, (_, index) => `add-${index}`),
      removeLabelIds: Array.from({ length: 13 }, (_, index) => `remove-${index}`),
    }),
    { code: "SAFETY_LIMIT" },
  );
  await assert.rejects(
    service.modifyLabels("work", ["message-1"], {
      addLabelIds: ["same-label"],
      removeLabelIds: ["same-label"],
    }),
    { code: "INVALID_INPUT" },
  );
  assert.equal(service.approvals.ttlMs, 300_000);
  assert.deepEqual(calls, { archive: 0, createDraft: 0, modifyLabels: 0, search: 0 });
});
