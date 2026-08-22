#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs")) files.push(absolute);
  }
}

await collect(path.join(pluginRoot, "src"));
await collect(path.join(pluginRoot, "scripts"));
files.push(path.join(pluginRoot, "scripts", "launch-mcp"));
files.push(path.join(pluginRoot, "scripts", "multi-email"));

for (const file of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error || result.status !== 0) process.exit(1);
}

process.stdout.write(`Syntax check passed (${new Set(files).size} files).\n`);
