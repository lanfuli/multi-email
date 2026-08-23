import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const ASSISTED_ONBOARDING_REFERENCE =
  "skills/multi-email/references/google-cloud-assisted-onboarding.md";
const PACKAGE_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function skillMetadataVersion(skillSource, { label = "Skill" } = {}) {
  if (typeof skillSource !== "string") {
    throw new Error(`${label} metadata.version is missing or invalid.`);
  }
  const frontmatter = skillSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter) {
    throw new Error(`${label} frontmatter is missing or invalid.`);
  }

  const lines = frontmatter[1].split(/\r?\n/u);
  const metadataIndexes = lines
    .map((line, index) => (line === "metadata:" ? index : -1))
    .filter((index) => index >= 0);
  if (metadataIndexes.length !== 1) {
    throw new Error(`${label} must contain exactly one metadata block.`);
  }

  const metadata = [];
  for (const line of lines.slice(metadataIndexes[0] + 1)) {
    if (line && !/^\s/u.test(line)) break;
    metadata.push(line);
  }
  const versionLines = metadata.filter((line) => /^ {2}version:/u.test(line));
  if (versionLines.length !== 1) {
    throw new Error(`${label} must contain exactly one quoted metadata.version.`);
  }
  const versionMatch = versionLines[0].match(
    /^ {2}version:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')\s*$/u,
  );
  const version = versionMatch?.[1] || versionMatch?.[2] || "";
  if (!PACKAGE_VERSION_PATTERN.test(version)) {
    throw new Error(`${label} metadata.version is missing or invalid.`);
  }
  return version;
}

export function assertVersionContract(contract, { label = "Package" } = {}) {
  const {
    packageVersion,
    pluginVersion,
    skillSource,
    runtimeVersion,
    buildVersion,
  } = contract || {};
  if (!PACKAGE_VERSION_PATTERN.test(String(packageVersion || ""))) {
    throw new Error(`${label} package version is missing or invalid.`);
  }
  const versions = [
    ["plugin", pluginVersion],
    ["Skill", skillMetadataVersion(skillSource, { label: `${label} Skill` })],
    ["runtime", runtimeVersion],
  ];
  if (Object.hasOwn(contract || {}, "buildVersion")) versions.push(["build", buildVersion]);
  for (const [component, version] of versions) {
    if (version !== packageVersion) {
      throw new Error(
        `${label} version mismatch: ${component} reports '${String(version)}', expected '${packageVersion}'.`,
      );
    }
  }
  return packageVersion;
}

function onboardingInvariant(condition, label, message) {
  if (!condition) throw new Error(`${label} ${message}`);
}

export async function validateAssistedOnboardingSurface(
  packageRoot,
  { label = "package" } = {},
) {
  const [reference, skill, readme, googleGuide, pluginRaw] = await Promise.all([
    readFile(path.join(packageRoot, ASSISTED_ONBOARDING_REFERENCE), "utf8"),
    readFile(path.join(packageRoot, "skills/multi-email/SKILL.md"), "utf8"),
    readFile(path.join(packageRoot, "README.md"), "utf8"),
    readFile(path.join(packageRoot, "docs/google-oauth.md"), "utf8"),
    readFile(path.join(packageRoot, ".codex-plugin/plugin.json"), "utf8"),
  ]);
  const plugin = JSON.parse(pluginRaw);
  const referenceName = path.posix.basename(ASSISTED_ONBOARDING_REFERENCE);
  const defaultPrompts = plugin.interface?.defaultPrompt;
  const normalizedReference = reference.replace(/\s+/gu, " ");
  const normalizedReadme = readme.replace(/\s+/gu, " ");

  onboardingInvariant(
    reference.trim().length > 0,
    label,
    "contains an empty assisted-onboarding reference.",
  );
  onboardingInvariant(
    skill.includes(`(references/${referenceName})`),
    label,
    "SKILL does not route assisted Google OAuth onboarding to its packaged reference.",
  );
  onboardingInvariant(
    /\bInternal\b/u.test(reference) && /\bExternal\b/u.test(reference),
    label,
    "assisted onboarding no longer requires an explicit Google audience decision.",
  );
  onboardingInvariant(
    /Create project.{0,120}confirmation/iu.test(normalizedReference) &&
      /real Google account email address.{0,180}not a Google identity/iu.test(
        normalizedReference,
      ),
    label,
    "assisted onboarding no longer protects new-project creation or real test-user identities.",
  );
  onboardingInvariant(
    /Testing.{0,420}seven days/iu.test(normalizedReference) &&
      /In production.{0,300}verified/iu.test(normalizedReference),
    label,
    "assisted onboarding no longer preserves the External publishing-status tradeoff.",
  );
  onboardingInvariant(
    /Create OAuth client.{0,420}action-time confirmation/iu.test(normalizedReference),
    label,
    "assisted onboarding no longer stops for credential-creation confirmation.",
  );
  onboardingInvariant(
    /passwords.{0,180}MFA.{0,180}CAPTCHA.{0,180}consent decisions/iu.test(
      normalizedReference,
    ),
    label,
    "assisted onboarding no longer hands authentication and consent decisions to the user.",
  );
  onboardingInvariant(
    /gmail\.modify.{0,260}not read-only.{0,260}confirm/iu.test(normalizedReference),
    label,
    "assisted onboarding no longer requires informed acceptance of the restricted Gmail scope.",
  );
  onboardingInvariant(
    /Terms of Service.{0,260}action-time confirmation/iu.test(normalizedReference),
    label,
    "assisted onboarding no longer protects legal and policy acknowledgements.",
  );
  onboardingInvariant(
    /must not inspect or capture.{0,180}credential dialog/iu.test(normalizedReference) &&
      /absolute local path/iu.test(normalizedReference) &&
      /mode-`0600` local config/iu.test(reference) &&
      /does not remove the downloaded source JSON/iu.test(normalizedReference),
    label,
    "assisted onboarding no longer protects the generated credential surface.",
  );
  onboardingInvariant(
    /user must personally click\s+Create/iu.test(normalizedReference) &&
      /Computer Use stops before Create.{0,100}user clicks/iu.test(normalizedReadme) &&
      /user personally clicks Create/iu.test(googleGuide.replace(/\s+/gu, " ")),
    label,
    "assisted onboarding no longer hands the credential-bearing Create UI to the user.",
  );
  onboardingInvariant(
    reference.includes("--confirm") &&
      reference.includes("--force") &&
      reference.includes("doctor <alias> --json"),
    label,
    "assisted onboarding no longer preserves guarded migration and per-alias verification.",
  );
  onboardingInvariant(
    Array.isArray(defaultPrompts) &&
      defaultPrompts.some(
        (prompt) =>
          typeof prompt === "string" &&
          /Google Cloud/iu.test(prompt) &&
          /Desktop OAuth client/iu.test(prompt) &&
          /Computer Use/iu.test(prompt),
      ),
    label,
    "plugin manifest lacks an assisted Google OAuth onboarding default prompt.",
  );
  onboardingInvariant(
    /Computer Use.{0,320}\boptional\b|\boptional\b.{0,320}Computer Use/iu.test(
      normalizedReadme,
    ),
    label,
    "README does not identify Computer Use as optional.",
  );
}

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function sourceFiles(directory, root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute, root)));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
}

async function regularArtifactFiles(directory, root, excluded) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = portable(path.relative(root, absolute));
    if (entry.isDirectory()) {
      files.push(...(await regularArtifactFiles(absolute, root, excluded)));
    } else if (entry.isFile()) {
      if (!excluded.has(relative)) files.push(relative);
    } else {
      throw new Error(`Unexpected non-regular build artifact: ${relative}`);
    }
  }
  return files;
}

export async function artifactFiles(
  distDirectory,
  { exclude = ["build-manifest.json"] } = {},
) {
  return (await regularArtifactFiles(distDirectory, distDirectory, new Set(exclude))).sort();
}

export async function buildInputFiles(pluginRoot) {
  const files = [
    "package.json",
    "package-lock.json",
    "scripts/build.mjs",
    "scripts/release-entry.cjs",
    "scripts/release-integrity.mjs",
    ...(await sourceFiles(path.join(pluginRoot, "src"), pluginRoot)),
  ];
  return files.sort();
}

export async function digestFiles(pluginRoot, relativeFiles) {
  const hash = createHash("sha256");
  for (const relative of [...relativeFiles].sort()) {
    const contents = await readFile(path.join(pluginRoot, relative));
    const name = Buffer.from(relative, "utf8");
    hash.update(Buffer.from(`${name.length}:`, "ascii"));
    hash.update(name);
    hash.update(Buffer.from(`:${contents.length}:`, "ascii"));
    hash.update(contents);
  }
  return hash.digest("hex");
}

export async function digestFile(absolutePath) {
  return createHash("sha256").update(await readFile(absolutePath)).digest("hex");
}
