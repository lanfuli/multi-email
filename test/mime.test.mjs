import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRawMessage,
  decodeBase64Url,
  extractGmailBody,
  normalizeAddresses,
  splitAddressHeader,
} from "../src/mime.mjs";

test("buildRawMessage creates a base64url RFC 5322 text message", () => {
  const encoded = buildRawMessage({
    to: [" Person@Example.COM "],
    cc: ["copy@example.com"],
    subject: "进度更新",
    body: "Hello, 世界",
  });
  const raw = Buffer.from(encoded, "base64url").toString("utf8");

  assert.match(raw, /^To: person@example\.com\r\n/m);
  assert.match(raw, /^Cc: copy@example\.com\r\n/m);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?.+\?=\r\n/m);
  assert.match(raw, /^Content-Transfer-Encoding: base64\r\n/m);
  assert.match(raw, new RegExp(Buffer.from("Hello, 世界", "utf8").toString("base64")));
});

test("message fields reject header injection and malformed recipients", () => {
  assert.throws(
    () => buildRawMessage({ to: ["ok@example.com"], subject: "Hello\r\nBcc: bad@example.com" }),
    { code: "INVALID_MESSAGE" },
  );
  assert.throws(() => normalizeAddresses(["not-an-address"], "to"), {
    code: "INVALID_MESSAGE",
  });
  for (const address of [
    "victim:attacker@example.com",
    "quoted local@example.com",
    "owner\0@example.com",
    '"quoted"@example.com',
  ]) {
    assert.throws(() => normalizeAddresses([address], "to"), {
      code: "INVALID_MESSAGE",
    });
  }
});

test("extractGmailBody walks nested MIME parts", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("Plain text", "utf8").toString("base64url") },
      },
      {
        mimeType: "multipart/related",
        parts: [
          {
            mimeType: "text/html",
            body: { data: Buffer.from("<p>HTML</p>", "utf8").toString("base64url") },
          },
        ],
      },
    ],
  };

  assert.deepEqual(extractGmailBody(payload), {
    body: "Plain text",
    htmlBody: "<p>HTML</p>",
  });
  assert.equal(decodeBase64Url(""), "");
});

test("splitAddressHeader extracts bare and display-name addresses", () => {
  assert.deepEqual(
    splitAddressHeader('"One, Primary" <ONE@example.com>, two@example.com'),
    ["one@example.com", "two@example.com"],
  );
});

test("splitAddressHeader rejects group syntax, controls, and malformed fragments", () => {
  for (const value of [
    "victim:attacker@example.com",
    "Friends: one@example.com, two@example.com;",
    "one\0@example.com",
    "bad, good@example.com",
    "one@example.com,",
    "Broken <one@example.com",
  ]) {
    assert.throws(() => splitAddressHeader(value), { code: "INVALID_MESSAGE" });
  }
});
