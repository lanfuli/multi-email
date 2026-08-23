import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { MultiEmailError } from "./errors.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const COOKIE_NAME = "multi_email_send_review";
const MAX_FORM_BYTES = 4_096;
export const MAX_APPROVAL_UI_SESSIONS = 16;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeEqual(first, second) {
  const actual = Buffer.from(String(first || ""));
  const expected = Buffer.from(String(second || ""));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function securityHeaders(styleNonce = undefined) {
  const styleSource = styleNonce ? `'nonce-${styleNonce}'` : "'none'";
  return {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Content-Security-Policy":
      `default-src 'none'; style-src ${styleSource}; form-action 'self'; ` +
      "base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendHtml(response, status, html, styleNonce = undefined, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders(styleNonce),
    "Content-Type": "text/html; charset=utf-8",
    ...extraHeaders,
  });
  response.end(html);
}

function errorPage(title, message) {
  return (
    "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">" +
    `<title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(message)}</p></html>`
  );
}

async function readForm(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_FORM_BYTES) {
      throw new MultiEmailError("Approval form is too large.", "INVALID_APPROVAL_FORM");
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function cookieValue(request, name) {
  for (const item of String(request.headers.cookie || "").split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return undefined;
}

export function defaultBrowserCommand(url, platform = process.platform) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== LOOPBACK_HOST) {
    throw new MultiEmailError(
      "Refusing to open a send approval URL outside local loopback.",
      "INVALID_APPROVAL_URL",
    );
  }

  let command;
  let args;
  if (platform === "darwin") {
    command = "/usr/bin/open";
    args = [target.href];
  } else if (platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", target.href];
  } else {
    command = "xdg-open";
    args = [target.href];
  }

  return { command, args };
}

export function openInDefaultBrowser(
  url,
  { platform = process.platform, spawnProcess = spawn } = {},
) {
  const { command, args } = defaultBrowserCommand(url, platform);

  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class LocalSendApprovalUi {
  constructor({
    approvalStore,
    browserOpener = openInDefaultBrowser,
    port = 0,
    clock = () => Date.now(),
    maxSessions = MAX_APPROVAL_UI_SESSIONS,
  } = {}) {
    if (!approvalStore) {
      throw new MultiEmailError(
        "LocalSendApprovalUi requires an approval store.",
        "INVALID_CONFIG",
      );
    }
    if (
      !Number.isInteger(maxSessions) ||
      maxSessions <= 0 ||
      maxSessions > MAX_APPROVAL_UI_SESSIONS
    ) {
      throw new MultiEmailError(
        `Local approval session capacity must be an integer from 1 to ${MAX_APPROVAL_UI_SESSIONS}.`,
        "INVALID_CONFIG",
      );
    }
    this.approvalStore = approvalStore;
    this.browserOpener = browserOpener;
    this.port = port;
    this.clock = clock;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.server = undefined;
    this.startPromise = undefined;
    this.origin = undefined;
  }

  async start() {
    if (this.origin) return this.origin;
    if (this.startPromise) return this.startPromise;

    this.server = createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        const status = error instanceof MultiEmailError ? 409 : 500;
        const message =
          error instanceof MultiEmailError
            ? error.message
            : "The local approval page failed. Prepare the draft again.";
        if (!response.headersSent) {
          sendHtml(response, status, errorPage("Approval failed", message));
        } else {
          response.destroy();
        }
      });
    });

    this.startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("Local approval server did not expose a TCP address."));
          return;
        }
        this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
        this.server?.unref();
        resolve(this.origin);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, LOOPBACK_HOST);
    });

    try {
      return await this.startPromise;
    } catch (error) {
      this.server = undefined;
      this.startPromise = undefined;
      throw new MultiEmailError(
        `Could not start the local approval page: ${error.message}`,
        "APPROVAL_UI_UNAVAILABLE",
      );
    }
  }

  async requestApproval(requestId) {
    const pending = this.approvalStore.getPendingReview(requestId);
    if (pending.status !== "pending") {
      throw new MultiEmailError(
        "Only a pending send request can be opened for review.",
        "SEND_APPROVAL_ALREADY_APPROVED",
      );
    }
    this.#sweepExpired();
    if (this.sessions.size >= this.maxSessions) {
      throw new MultiEmailError(
        "Too many local approval windows are awaiting a decision. Finish or close an existing review before opening another.",
        "APPROVAL_UI_CAPACITY",
      );
    }

    const sessionId = randomBytes(24).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const cookie = randomBytes(24).toString("base64url");
    this.sessions.set(sessionId, {
      requestId,
      csrf,
      cookie,
      expiresAt: Date.parse(pending.expiresAt),
    });

    try {
      await this.start();
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
    const url = `${this.origin}/review/${sessionId}`;

    try {
      await this.browserOpener(url);
    } catch (error) {
      this.sessions.delete(sessionId);
      throw new MultiEmailError(
        `Could not open the local approval page: ${error.message}`,
        "APPROVAL_UI_UNAVAILABLE",
      );
    }

    return { url, expiresAt: pending.expiresAt };
  }

  sessionCount() {
    this.#sweepExpired();
    return this.sessions.size;
  }

  async stop() {
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    this.startPromise = undefined;
    this.origin = undefined;
    if (!server?.listening) return;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #validHost(request) {
    return String(request.headers.host || "").toLowerCase() === new URL(this.origin).host;
  }

  #validFetchContext(request, { requireOrigin = false } = {}) {
    const origin = request.headers.origin;
    if (requireOrigin && origin !== this.origin) return false;
    if (origin && origin !== this.origin) return false;
    const fetchSite = String(request.headers["sec-fetch-site"] || "");
    return !fetchSite || fetchSite === "none" || fetchSite === "same-origin";
  }

  #session(sessionId) {
    this.#sweepExpired();
    const session = this.sessions.get(sessionId);
    return session;
  }

  #sweepExpired(now = this.clock()) {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
  }

  async #handle(request, response) {
    if (!this.#validHost(request)) {
      sendHtml(response, 403, errorPage("Forbidden", "Invalid local host header."));
      return;
    }

    const url = new URL(request.url || "/", this.origin);
    if (url.origin !== this.origin) {
      sendHtml(response, 403, errorPage("Forbidden", "Invalid request origin."));
      return;
    }
    const reviewMatch = url.pathname.match(/^\/review\/([A-Za-z0-9_-]+)$/u);
    const decisionMatch = url.pathname.match(/^\/review\/([A-Za-z0-9_-]+)\/decision$/u);

    if (request.method === "GET" && reviewMatch) {
      if (!this.#validFetchContext(request)) {
        sendHtml(response, 403, errorPage("Forbidden", "Cross-site review is not allowed."));
        return;
      }
      this.#renderReview(response, reviewMatch[1]);
      return;
    }

    if (request.method === "POST" && decisionMatch) {
      if (!this.#validFetchContext(request, { requireOrigin: true })) {
        sendHtml(response, 403, errorPage("Forbidden", "Cross-site approval is not allowed."));
        return;
      }
      if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(request.headers["content-type"] || "")) {
        sendHtml(response, 415, errorPage("Unsupported request", "Invalid approval form type."));
        return;
      }
      await this.#applyDecision(request, response, decisionMatch[1]);
      return;
    }

    if (reviewMatch || decisionMatch) {
      response.writeHead(405, { ...securityHeaders(), Allow: reviewMatch ? "GET" : "POST" });
      response.end();
      return;
    }
    sendHtml(response, 404, errorPage("Not found", "This approval page is not available."));
  }

  #renderReview(response, sessionId) {
    const session = this.#session(sessionId);
    if (!session) {
      sendHtml(response, 410, errorPage("Review expired", "Prepare the draft again."));
      return;
    }
    const pending = this.approvalStore.getPendingReview(session.requestId);
    if (pending.status !== "pending") {
      this.sessions.delete(sessionId);
      sendHtml(response, 409, errorPage("Already decided", "This request is no longer pending."));
      return;
    }

    const { review } = pending;
    const styleNonce = randomBytes(18).toString("base64url");
    const action = `/review/${sessionId}/decision`;
    const maxAge = Math.max(0, Math.ceil((session.expiresAt - this.clock()) / 1000));
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review email before sending</title>
  <style nonce="${styleNonce}">
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 840px; margin: 32px auto; padding: 0 20px 48px; line-height: 1.45; }
    dl { display: grid; grid-template-columns: 90px 1fr; gap: 8px 16px; }
    dt { font-weight: 700; } dd { margin: 0; overflow-wrap: anywhere; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #8888; border-radius: 8px; padding: 16px; }
    .warning { padding: 12px 16px; border: 1px solid #c66; border-radius: 8px; }
    form { display: flex; gap: 12px; margin-top: 20px; }
    button { font: inherit; font-weight: 700; padding: 10px 16px; cursor: pointer; }
    .approve { background: #176b3a; color: white; border: 0; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Review the complete email</h1>
  <p class="warning">Click Approve only after checking the mailbox identity, every recipient, subject, format, attachments, and the complete body below.</p>
  <dl>
    <dt>Account</dt><dd>${escapeHtml(review.account)}</dd>
    <dt>Provider</dt><dd>${escapeHtml(review.provider)}</dd>
    <dt>Authenticated principal</dt><dd>${escapeHtml(review.authenticatedPrincipal)}</dd>
    <dt>Mailbox</dt><dd>${escapeHtml(review.mailboxResource)}</dd>
    <dt>Draft</dt><dd>${escapeHtml(review.draftId)}</dd>
    <dt>From</dt><dd>${escapeHtml(review.from)}</dd>
    <dt>Sender</dt><dd>${escapeHtml(review.sender || "(none)")}</dd>
    <dt>Reply-To</dt><dd>${escapeHtml(review.replyTo.join(", ") || "(none)")}</dd>
    <dt>To</dt><dd>${escapeHtml(review.to.join(", ") || "(none)")}</dd>
    <dt>Cc</dt><dd>${escapeHtml(review.cc.join(", ") || "(none)")}</dd>
    <dt>Bcc</dt><dd>${escapeHtml(review.bcc.join(", ") || "(none)")}</dd>
    <dt>Subject</dt><dd>${escapeHtml(review.subject || "(empty)")}</dd>
    <dt>In-Reply-To</dt><dd>${escapeHtml(review.inReplyTo || "(none)")}</dd>
    <dt>References</dt><dd>${escapeHtml(review.references || "(none)")}</dd>
    <dt>Format</dt><dd>${escapeHtml(review.bodyFormat)}</dd>
    <dt>Attachments</dt><dd>${review.attachments.length === 0 ? "none" : "present"}</dd>
  </dl>
  <h2>Complete body</h2>
  <pre>${escapeHtml(review.body)}</pre>
  <form method="post" action="${action}">
    <input type="hidden" name="csrf" value="${session.csrf}">
    <input type="hidden" name="fingerprint" value="${pending.fingerprint}">
    <button class="approve" type="submit" name="decision" value="approve">Approve one send</button>
    <button type="submit" name="decision" value="reject">Reject</button>
  </form>
</body>
</html>`;
    sendHtml(response, 200, html, styleNonce, {
      "Set-Cookie":
        `${COOKIE_NAME}=${session.cookie}; HttpOnly; SameSite=Strict; ` +
        `Path=/review/${sessionId}; Max-Age=${maxAge}`,
    });
  }

  async #applyDecision(request, response, sessionId) {
    const session = this.#session(sessionId);
    if (!session) {
      sendHtml(response, 410, errorPage("Review expired", "Prepare the draft again."));
      return;
    }
    const form = await readForm(request);
    if (
      !safeEqual(cookieValue(request, COOKIE_NAME), session.cookie) ||
      !safeEqual(form.get("csrf"), session.csrf)
    ) {
      sendHtml(response, 403, errorPage("Forbidden", "Invalid approval session."));
      return;
    }

    const decision = form.get("decision");
    if (decision === "approve") {
      this.approvalStore.approveOutOfBand(
        session.requestId,
        form.get("fingerprint"),
      );
      this.sessions.delete(sessionId);
      sendHtml(
        response,
        200,
        errorPage(
          "Approved",
          "One send is now enabled for this exact unchanged draft. You may close this window.",
        ),
      );
      return;
    }
    if (decision === "reject") {
      this.approvalStore.rejectOutOfBand(session.requestId);
      this.sessions.delete(sessionId);
      sendHtml(response, 200, errorPage("Rejected", "This draft will not be sent."));
      return;
    }
    sendHtml(response, 400, errorPage("Invalid decision", "Choose Approve or Reject."));
  }
}
