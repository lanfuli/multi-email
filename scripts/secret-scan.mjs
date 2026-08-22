#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const forbiddenNames = [
  /^\.env(?:\..+)?$/i,
  /^client_secret.*\.json$/i,
  /^config\.json$/i,
  /^credentials.*\.json$/i,
  /^oauth-client.*\.json$/i,
  /^token.*\.json$/i,
];
const secretRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/g],
  ["Google OAuth client secret", /GOCSPX-[0-9A-Za-z_-]{20,}/g],
  ["GitHub token", /gh[pousr]_[0-9A-Za-z]{30,}/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
];
const findings = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(pluginRoot, absolute);
    if (entry.isDirectory()) {
      await scan(absolute);
      continue;
    }
    if (!entry.isFile()) continue;

    if (forbiddenNames.some((pattern) => pattern.test(entry.name))) {
      findings.push(`${relative}: sensitive filename`);
      continue;
    }

    const contents = await readFile(absolute);
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    for (const [label, pattern] of secretRules) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split("\n").length;
        findings.push(`${relative}:${line}: ${label}`);
      }
    }
  }
}

await scan(pluginRoot);
if (findings.length) {
  console.error("Potential secrets or sensitive files detected:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

process.stdout.write("Secret scan passed.\n");
