import { MultiEmailError } from "./errors.mjs";

const EMAIL_PATTERN = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u;

function assertNoHeaderBreak(value, field) {
  if (/[\r\n]/.test(String(value))) {
    throw new MultiEmailError(`${field} contains an invalid line break.`, "INVALID_MESSAGE");
  }
}

export function normalizeAddresses(values = [], field = "recipient") {
  if (!Array.isArray(values)) {
    throw new MultiEmailError(`${field} must be an array.`, "INVALID_MESSAGE");
  }
  return values.map((value) => {
    const address = String(value).trim().toLowerCase();
    assertNoHeaderBreak(address, field);
    if (!EMAIL_PATTERN.test(address)) {
      throw new MultiEmailError(`Invalid ${field} address '${address}'.`, "INVALID_MESSAGE");
    }
    return address;
  });
}

export function encodeHeader(value) {
  const text = String(value || "");
  assertNoHeaderBreak(text, "header");
  if (/^[\x20-\x7e]*$/.test(text) && text.length <= 70) {
    return text;
  }
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunk && bytes + characterBytes > 45) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks
    .map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

function foldBase64(value) {
  return Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
}

function foldAddresses(name, addresses) {
  return `${name}: ${addresses.join(",\r\n ")}`;
}

function foldReferences(value) {
  const tokens = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "References:";
  for (const token of tokens) {
    if (token.length > 900) {
      throw new MultiEmailError("References contains an invalid message ID.", "INVALID_MESSAGE");
    }
    if (line.length + token.length + 1 > 78 && line !== "References:") {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  if (tokens.length) lines.push(line);
  return lines.join("\r\n");
}

export function buildRawMessage({
  from,
  to = [],
  cc = [],
  bcc = [],
  subject = "",
  body = "",
  inReplyTo,
  references,
}) {
  const normalizedFrom = from ? normalizeAddresses([from], "from")[0] : undefined;
  const normalizedTo = normalizeAddresses(to, "to");
  const normalizedCc = normalizeAddresses(cc, "cc");
  const normalizedBcc = normalizeAddresses(bcc, "bcc");
  const subjectText = String(subject || "");
  const bodyText = String(body || "");
  assertNoHeaderBreak(subjectText, "subject");

  if (Buffer.byteLength(bodyText, "utf8") > 1024 * 1024) {
    throw new MultiEmailError("Draft body exceeds the 1 MB safety limit.", "INVALID_MESSAGE");
  }

  const headers = [];
  if (normalizedFrom) headers.push(`From: ${normalizedFrom}`);
  if (normalizedTo.length) headers.push(foldAddresses("To", normalizedTo));
  if (normalizedCc.length) headers.push(foldAddresses("Cc", normalizedCc));
  if (normalizedBcc.length) headers.push(foldAddresses("Bcc", normalizedBcc));
  headers.push(`Subject: ${encodeHeader(subjectText)}`);
  if (inReplyTo) {
    assertNoHeaderBreak(inReplyTo, "In-Reply-To");
    if (String(inReplyTo).length > 900) {
      throw new MultiEmailError("In-Reply-To is too long.", "INVALID_MESSAGE");
    }
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (references) {
    assertNoHeaderBreak(references, "References");
    headers.push(foldReferences(references));
  }
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  const raw = `${headers.join("\r\n")}\r\n\r\n${foldBase64(bodyText)}\r\n`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeBase64Url(data = "") {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

export function headersToObject(headers = []) {
  const result = {};
  for (const header of headers || []) {
    if (!header?.name) continue;
    result[header.name.toLowerCase()] = header.value || "";
  }
  return result;
}

function collectBodies(part, output) {
  if (!part) return;
  const mimeType = String(part.mimeType || "").toLowerCase();
  const content = decodeBase64Url(part.body?.data || "");
  if (mimeType === "text/plain" && content) output.text.push(content);
  if (mimeType === "text/html" && content) output.html.push(content);
  for (const child of part.parts || []) collectBodies(child, output);
}

export function extractGmailBody(payload) {
  const output = { text: [], html: [] };
  collectBodies(payload, output);
  return {
    body: output.text.join("\n\n") || "",
    htmlBody: output.html.join("\n\n") || "",
  };
}

export function splitAddressHeader(value = "") {
  return String(value)
    .split(",")
    .map((entry) => {
      const angle = entry.match(/<([^>]+)>/);
      return (angle?.[1] || entry).trim().toLowerCase();
    })
    .filter((entry) => EMAIL_PATTERN.test(entry));
}
