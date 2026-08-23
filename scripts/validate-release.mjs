#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactFiles,
  buildInputFiles,
  digestFile,
  digestFiles,
} from "./release-integrity.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(pluginRoot, relative), "utf8"));
const packageJson = await readJson("package.json");
const plugin = await readJson(".codex-plugin/plugin.json");
const marketplace = await readJson(".agents/plugins/marketplace.json");
const build = await readJson("dist/build-manifest.json");
const skill = await readFile(path.join(pluginRoot, "skills/multi-email/SKILL.md"), "utf8");
const readme = await readFile(path.join(pluginRoot, "README.md"), "utf8");
const changelog = await readFile(path.join(pluginRoot, "CHANGELOG.md"), "utf8");
const constants = await readFile(path.join(pluginRoot, "src/constants.mjs"), "utf8");
const googleOAuthGuide = await readFile(path.join(pluginRoot, "docs/google-oauth.md"), "utf8");
const microsoftEntraGuide = await readFile(
  path.join(pluginRoot, "docs/microsoft-entra.md"),
  "utf8",
);
const continuousIntegration = await readFile(
  path.join(pluginRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const buildInputs = await buildInputFiles(pluginRoot);
const instructionFiles = [
  ...buildInputs.filter((relative) => relative.startsWith("src/")),
  "scripts/launch-mcp",
  "scripts/multi-email",
  "skills/multi-email/SKILL.md",
  "skills/multi-email/agents/openai.yaml",
];
const publishedInstructions = (
  await Promise.all(
    instructionFiles.map((relative) => readFile(path.join(pluginRoot, relative), "utf8")),
  )
).join("\n");

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
assert(packageJson.files?.includes("assets/"), "The package files whitelist omits plugin assets.");
assert(packageJson.files?.includes("docs/"), "The package files whitelist omits OAuth guides.");
assert(
  packageJson.files?.includes("CONTRIBUTING.md") &&
    packageJson.files?.includes("CODE_OF_CONDUCT.md"),
  "The package files whitelist leaves README documentation links broken.",
);

assert(plugin.name === "multi-email", "Unexpected Codex plugin name.");
assert(plugin.version === packageJson.version, "Plugin and package versions differ.");
assert(plugin.author?.name === "Vincent_Lan", "Plugin author is incorrect.");
assert(plugin.license === "MIT", "Plugin manifest must declare MIT.");
assert(plugin.mcpServers === "./.mcp.json", "Plugin MCP manifest path is incorrect.");
assert(plugin.interface?.brandColor === "#0B2B66", "Plugin brand color is incorrect.");
assert(
  plugin.interface?.composerIcon === "./assets/plugin-icon.png" &&
    plugin.interface?.logo === "./assets/plugin-icon.png",
  "Plugin icon metadata is incomplete.",
);
assert(
  constants.includes(`APP_VERSION = "${packageJson.version}"`),
  "Runtime and package versions differ.",
);
assert(
  readme.includes(`Release status: \`${packageJson.version}\``),
  "README release status does not match the package version.",
);
assert(
  changelog.includes(`## [${packageJson.version}]`),
  "CHANGELOG lacks the current package version.",
);
assert(
  readme.includes(
    `codex plugin marketplace add lanfuli/multi-email --ref v${packageJson.version}`,
  ),
  "README Git marketplace installation is not pinned to the release tag.",
);
assert(
  readme.includes("does not place the setup CLI on your shell `PATH`") &&
    skill.includes("do not assume a marketplace install placed the setup CLI on `PATH`"),
  "Marketplace setup guidance incorrectly assumes that the CLI binary is installed.",
);
assert(
  readme.includes("docs/google-oauth.md") && readme.includes("docs/microsoft-entra.md"),
  "README does not link both provider OAuth guides.",
);
assert(
  googleOAuthGuide.includes("https://developers.google.com/workspace/gmail/api/auth/scopes") &&
    microsoftEntraGuide.includes("https://learn.microsoft.com/en-us/graph/permissions-reference"),
  "OAuth guides do not link their authoritative provider permission references.",
);
assert(
  googleOAuthGuide.includes("**Desktop app**") &&
    googleOAuthGuide.includes("`openid`") &&
    googleOAuthGuide.includes("`email`") &&
    googleOAuthGuide.includes("`https://www.googleapis.com/auth/gmail.modify`"),
  "Google OAuth guide no longer preserves the supported desktop client and exact scopes.",
);
assert(
  microsoftEntraGuide.includes("**Add a platform > Mobile and desktop applications**") &&
    microsoftEntraGuide.includes("`http://localhost`") &&
    microsoftEntraGuide.includes("Leave **Allow public client flows** at its default **No**") &&
    ["`User.Read`", "`Mail.ReadWrite`", "`Mail.Send`"].every((permission) =>
      microsoftEntraGuide.includes(permission),
    ),
  "Microsoft Entra guide no longer preserves the supported desktop redirect and delegated permissions.",
);
assert(
  continuousIntegration.includes("fetch-depth: 0") &&
    continuousIntegration.includes('git cat-file -t "refs/tags/$GITHUB_REF_NAME"') &&
    continuousIntegration.includes('= tag'),
  "CI no longer rejects lightweight release tags.",
);
assert(
  !readme.includes("\nnpm run setup") &&
    !/\bnpm run setup\b|\bsetup (?:add-account|auth|doctor|init|list|logout|revoke|set-microsoft-client)\b/iu.test(
      publishedInstructions,
    ),
  "Consumer-incompatible npm run setup guidance remains.",
);

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
assert(build.appVersion === packageJson.version, "Bundled app version is stale.");
assert(build.ncc === packageJson.devDependencies?.["@vercel/ncc"], "ncc versions differ.");
assert(build.keyring === packageJson.dependencies?.["@napi-rs/keyring"], "Keyring versions differ.");
assert(
  build.sourceSha256 === await digestFiles(pluginRoot, buildInputs),
  "Bundled source digest is stale. Run npm run build and commit dist.",
);
const distDirectory = path.join(pluginRoot, "dist");
const currentArtifacts = await artifactFiles(distDirectory);
const recordedArtifacts = Object.keys(build.artifacts || {}).sort();
assert(
  JSON.stringify(recordedArtifacts) === JSON.stringify(currentArtifacts),
  "Bundle artifact manifest does not exactly match the dist file set.",
);
for (const [file, expected] of Object.entries(build.artifacts || {})) {
  assert(/^[a-f0-9]{64}$/.test(expected), `Bundled artifact digest is invalid for ${file}.`);
  assert(
    expected === await digestFile(path.join(distDirectory, file)),
    `Bundled artifact digest is stale for ${file}.`,
  );
}
assert(
  JSON.stringify([...(build.nativeAssets || [])].sort()) ===
    JSON.stringify(["keyring.darwin-arm64.node", "keyring.darwin-x64.node"]),
  "Bundle native asset manifest is incomplete.",
);

for (const relative of [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "docs/google-oauth.md",
  "docs/microsoft-entra.md",
  "assets/plugin-icon.png",
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
