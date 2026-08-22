import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MultiEmailError } from "./errors.mjs";

function cloneReview(review) {
  return {
    account: review.account,
    draftId: review.draftId,
    messageId: review.messageId,
    to: [...(review.to || [])],
    cc: [...(review.cc || [])],
    bcc: [...(review.bcc || [])],
    subject: review.subject || "",
    body: review.body || "",
  };
}

function stableDraftFingerprint(review) {
  const payload = JSON.stringify({
    version: 1,
    account: review.account,
    draftId: review.draftId,
    messageId: review.messageId || "",
    to: [...(review.to || [])].sort(),
    cc: [...(review.cc || [])].sort(),
    bcc: [...(review.bcc || [])].sort(),
    subject: review.subject || "",
    body: review.body || "",
  });
  return createHash("sha256").update(payload).digest("hex");
}

function safeEqual(first, second) {
  const actual = Buffer.from(String(first || ""));
  const expected = Buffer.from(String(second || ""));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SendApprovalStore {
  constructor({ ttlSeconds = 300, clock = () => Date.now() } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.clock = clock;
    this.requests = new Map();
  }

  prepare(review) {
    const requestId = `sar_${randomBytes(24).toString("base64url")}`;
    const expiresAt = this.clock() + this.ttlMs;
    const snapshot = cloneReview(review);
    this.requests.set(requestId, {
      snapshot,
      fingerprint: stableDraftFingerprint(snapshot),
      status: "pending",
      expiresAt,
    });
    return {
      requestId,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  #request(requestId) {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new MultiEmailError(
        "Send approval is missing, rejected, or already used. Prepare the draft again.",
        "SEND_APPROVAL_REQUIRED",
      );
    }
    if (request.expiresAt <= this.clock()) {
      this.requests.delete(requestId);
      throw new MultiEmailError(
        "Send approval expired. Prepare and review the draft again.",
        "SEND_APPROVAL_EXPIRED",
      );
    }
    return request;
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
    this.requests.delete(requestId);
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
      this.requests.delete(requestId);
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
    this.requests.delete(requestId);

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
