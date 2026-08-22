#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(pluginRoot, relative), "utf8"));
const packageJson = await readJson("package.json");
const plugin = await readJson(".codex-plugin/plugin.json");
const marketplace = await readJson(".agents/plugins/marketplace.json");
const build = await readJson("dist/build-manifest.json");
const skill = await readFile(path.join(pluginRoot, "skills/multi-email/SKILL.md"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function mustExist(relative) {
  await access(path.join(pluginRoot, relative));
}

assert(packageJson.name === "codex-multi-email", "Unexpected npm package name.");
assert(packageJson.private !== true, "The npm package is still private.");
assert(packageJson.license === "MIT", "package.json must declare MIT.");
assert(packageJson.author?.name === "Vincent_Lan", "package author is incorrect.");
assert(packageJson.repository?.url?.includes("lanfuli/multi-email"), "Repository metadata is missing.");
assert(packageJson.bin?.["multi-email"], "The setup CLI bin is missing.");
assert(packageJson.bin?.["multi-email-mcp"], "The MCP bin is missing.");
assert(packageJson.files?.includes("dist/"), "The package files whitelist omits dist.");

assert(plugin.name === "multi-email", "Unexpected Codex plugin name.");
assert(plugin.version === packageJson.version, "Plugin and package versions differ.");
assert(plugin.author?.name === "Vincent_Lan", "Plugin author is incorrect.");
assert(plugin.license === "MIT", "Plugin manifest must declare MIT.");
assert(plugin.mcpServers === "./.mcp.json", "Plugin MCP manifest path is incorrect.");

assert(marketplace.name === "multi-email", "Unexpected marketplace name.");
assert(marketplace.plugins?.length === 1, "Marketplace must contain exactly one plugin.");
assert(marketplace.plugins[0]?.name === "multi-email", "Marketplace plugin name is incorrect.");
assert(marketplace.plugins[0]?.source === "./", "Marketplace must target the repository root.");
assert(
  marketplace.plugins[0]?.policy?.installation === "AVAILABLE" &&
    marketplace.plugins[0]?.policy?.authentication === "ON_INSTALL",
  "Marketplace policies are incomplete.",
);

assert(/^---\nname: multi-email\n/.test(skill), "Skill frontmatter is invalid.");
assert(
  skill.includes("server-enforced localhost review window") ||
    skill.includes("server opens a `127.0.0.1` review window"),
  "Skill lacks the out-of-band send requirement.",
);

assert(build.entry === "server.cjs", "Unexpected bundled entry.");
assert(build.ncc === packageJson.devDependencies?.["@vercel/ncc"], "ncc versions differ.");
assert(build.keyring === packageJson.dependencies?.["@napi-rs/keyring"], "Keyring versions differ.");

for (const relative of [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  ".mcp.json",
  ".codex-plugin/plugin.json",
  "dist/server.cjs",
  "dist/keyring.darwin-arm64.node",
  "dist/keyring.darwin-x64.node",
  "scripts/launch-mcp",
  "scripts/multi-email",
  "skills/multi-email/SKILL.md",
]) {
  await mustExist(relative);
}

try {
  await access(path.join(pluginRoot, ".codex-plugin", "plugin 2.json"));
  throw new Error("Duplicate plugin manifest still exists.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

process.stdout.write("Release metadata and bundle validation passed.\n");
