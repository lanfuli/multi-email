import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HARD_SAFETY_LIMITS } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";

export const EFFECTIVE_SEND_MANIFEST_VERSION = 1;
export const EFFECTIVE_SEND_POLICY_VERSION = 2;

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
  constructor({ ttlSeconds = 300, clock = () => Date.now() } = {}) {
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
