import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildRawMessage } from "../src/mime.mjs";
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
} = {}) {
  const calls = { get: [], send: 0, sendRequests: [] };
  let currentFull = structuredClone(full);
  let currentRaw = structuredClone(raw);
  let queuedRaw = rawSequence?.map((value) => structuredClone(value)) || null;
  let rawIndex = 0;
  const gmail = {
    users: {
      drafts: {
        async get(request) {
          calls.get.push(structuredClone(request));
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
        async send(request) {
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
          calls.sendRequests.push(structuredClone(request));
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
  };
}

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
