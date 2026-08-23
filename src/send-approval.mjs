import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HARD_SAFETY_LIMITS } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";

export const EFFECTIVE_SEND_MANIFEST_VERSION = 1;
export const EFFECTIVE_SEND_POLICY_VERSION = 2;
export const SEND_APPROVAL_STORE_LIMITS = Object.freeze({
  maxPendingRequests: 16,
  maxRetainedBytes: 16 * 1024 * 1024,
});

function cloneProviderRevision(review, messageId, threadId) {
  const revision = review.providerRevision || {};
  return {
    messageId: revision.messageId ?? messageId,
    threadId: revision.threadId ?? threadId,
    rawPayloadSha256: revision.rawPayloadSha256 ?? null,
    changeKey: revision.changeKey ?? null,
    lastModifiedDateTime: revision.lastModifiedDateTime ?? null,
  };
}

function cloneReview(review) {
  const body = typeof review.body === "string" ? review.body : "";
  const messageId = review.messageId ?? "";
  const threadId = review.threadId ?? null;
  return {
    manifestVersion: review.manifestVersion ?? EFFECTIVE_SEND_MANIFEST_VERSION,
    policyVersion: review.policyVersion ?? EFFECTIVE_SEND_POLICY_VERSION,
    account: review.account,
    provider: review.provider ?? "",
    authenticatedPrincipal: review.authenticatedPrincipal ?? "",
    mailboxResource: review.mailboxResource ?? "",
    draftId: review.draftId,
    messageId,
    threadId,
    from: review.from ?? "",
    sender: review.sender ?? "",
    replyTo: [...(review.replyTo || [])],
    to: [...(review.to || [])],
    cc: [...(review.cc || [])],
    bcc: [...(review.bcc || [])],
    subject: review.subject || "",
    inReplyTo: review.inReplyTo ?? "",
    references: review.references ?? "",
    body,
    bodyFormat: review.bodyFormat ?? "",
    bodySha256:
      review.bodySha256 ?? createHash("sha256").update(body, "utf8").digest("hex"),
    attachments: structuredClone(review.attachments || []),
    completeness: review.completeness ?? "",
    providerRevision: cloneProviderRevision(review, messageId, threadId),
  };
}

function stableDraftFingerprint(review) {
  const manifest = cloneReview(review);
  manifest.replyTo.sort();
  manifest.to.sort();
  manifest.cc.sort();
  manifest.bcc.sort();
  const payload = JSON.stringify(manifest);
  return createHash("sha256").update(payload).digest("hex");
}

function safeEqual(first, second) {
  const actual = Buffer.from(String(first || ""));
  const expected = Buffer.from(String(second || ""));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SendApprovalStore {
  constructor({
    ttlSeconds = 300,
    clock = () => Date.now(),
    maxPendingRequests = SEND_APPROVAL_STORE_LIMITS.maxPendingRequests,
    maxRetainedBytes = SEND_APPROVAL_STORE_LIMITS.maxRetainedBytes,
  } = {}) {
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds <= 0 ||
      ttlSeconds > HARD_SAFETY_LIMITS.sendApprovalTtlSeconds
    ) {
      throw new MultiEmailError(
        `Send approval TTL must be an integer from 1 to ${HARD_SAFETY_LIMITS.sendApprovalTtlSeconds} seconds.`,
        "INVALID_CONFIG",
      );
    }
    if (
      !Number.isInteger(maxPendingRequests) ||
      maxPendingRequests <= 0 ||
      maxPendingRequests > SEND_APPROVAL_STORE_LIMITS.maxPendingRequests
    ) {
      throw new MultiEmailError(
        `Send approval capacity must be an integer from 1 to ${SEND_APPROVAL_STORE_LIMITS.maxPendingRequests}.`,
        "INVALID_CONFIG",
      );
    }
    if (
      !Number.isInteger(maxRetainedBytes) ||
      maxRetainedBytes <= 0 ||
      maxRetainedBytes > SEND_APPROVAL_STORE_LIMITS.maxRetainedBytes
    ) {
      throw new MultiEmailError(
        `Send approval retained-byte capacity must be an integer from 1 to ${SEND_APPROVAL_STORE_LIMITS.maxRetainedBytes}.`,
        "INVALID_CONFIG",
      );
    }
    this.ttlMs = ttlSeconds * 1000;
    this.clock = clock;
    this.maxPendingRequests = maxPendingRequests;
    this.maxRetainedBytes = maxRetainedBytes;
    this.requests = new Map();
    this.retainedBytes = 0;
  }

  prepare(review) {
    this.#sweepExpired();
    const requestId = `sar_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.clock() + this.ttlMs;
    const snapshot = cloneReview(review);
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (
      this.requests.size >= this.maxPendingRequests ||
      snapshotBytes > this.maxRetainedBytes - this.retainedBytes
    ) {
      throw new MultiEmailError(
        "Too many send approvals are awaiting review. Finish, reject, or let an existing review expire before preparing another draft.",
        "SEND_APPROVAL_CAPACITY",
      );
    }
    this.requests.set(requestId, {
      snapshot,
      snapshotBytes,
      fingerprint: stableDraftFingerprint(snapshot),
      status: "pending",
      expiresAt,
    });
    this.retainedBytes += snapshotBytes;
    return {
      requestId,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  #delete(requestId) {
    const request = this.requests.get(requestId);
    if (!request) return false;
    this.requests.delete(requestId);
    this.retainedBytes -= request.snapshotBytes;
    return true;
  }

  #sweepExpired(now = this.clock()) {
    for (const [requestId, request] of this.requests) {
      if (request.expiresAt <= now) this.#delete(requestId);
    }
  }

  #request(requestId) {
    const request = this.requests.get(requestId);
    const now = this.clock();
    const expired = request?.expiresAt <= now;
    this.#sweepExpired(now);
    if (!request) {
      throw new MultiEmailError(
        "Send approval is missing, rejected, or already used. Prepare the draft again.",
        "SEND_APPROVAL_REQUIRED",
      );
    }
    if (expired) {
      throw new MultiEmailError(
        "Send approval expired. Prepare and review the draft again.",
        "SEND_APPROVAL_EXPIRED",
      );
    }
    return request;
  }

  stats() {
    this.#sweepExpired();
    return {
      pendingRequests: this.requests.size,
      retainedBytes: this.retainedBytes,
    };
  }

  // Safe, idempotent cleanup for callers that could not present the review UI.
  discard(requestId) {
    return this.#delete(requestId);
  }

  getPendingReview(requestId) {
    const request = this.#request(requestId);
    return {
      requestId,
      status: request.status,
      expiresAt: new Date(request.expiresAt).toISOString(),
      fingerprint: request.fingerprint,
      review: cloneReview(request.snapshot),
    };
  }

  // This method is intentionally absent from MailService and every MCP tool.
  // Only a trusted local human-review surface may call it.
  approveOutOfBand(requestId, expectedFingerprint) {
    const request = this.#request(requestId);
    if (request.status === "approved") {
      throw new MultiEmailError(
        "This send request is already approved.",
        "SEND_APPROVAL_ALREADY_APPROVED",
      );
    }
    if (!safeEqual(expectedFingerprint, request.fingerprint)) {
      throw new MultiEmailError(
        "The reviewed draft fingerprint does not match this send request.",
        "SEND_APPROVAL_MISMATCH",
      );
    }
    request.status = "approved";
    request.approvedAt = this.clock();
    return {
      requestId,
      status: "approved",
      expiresAt: new Date(request.expiresAt).toISOString(),
    };
  }

  // Rejection is also out of band. Removing the request makes rejection final.
  rejectOutOfBand(requestId) {
    this.#request(requestId);
    this.#delete(requestId);
    return { requestId, status: "rejected" };
  }

  requireApproved(requestId, expected = {}) {
    const request = this.#request(requestId);
    if (request.status !== "approved") {
      throw new MultiEmailError(
        "This draft is still awaiting approval in the local human-review window.",
        "SEND_APPROVAL_REQUIRED",
      );
    }
    if (
      (expected.account && request.snapshot.account !== expected.account) ||
      (expected.draftId && request.snapshot.draftId !== expected.draftId)
    ) {
      this.#delete(requestId);
      throw new MultiEmailError(
        "Send approval does not match this account and draft.",
        "SEND_APPROVAL_MISMATCH",
      );
    }
    return true;
  }

  consumeApproved(requestId, review) {
    const request = this.#request(requestId);
    this.requireApproved(requestId, {
      account: review.account,
      draftId: review.draftId,
    });

    // Approval is spent before any validation or provider network call. A mismatch
    // or ambiguous provider outcome must always require a fresh human review.
    this.#delete(requestId);

    if (!safeEqual(stableDraftFingerprint(review), request.fingerprint)) {
      throw new MultiEmailError(
        "The draft changed after approval. Prepare and review it again before sending.",
        "DRAFT_CHANGED",
      );
    }
    return true;
  }
}

export { stableDraftFingerprint };
