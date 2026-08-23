import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { APP_VERSION } from "./constants.mjs";

const RUNTIME_INFO_SYMBOL = Symbol.for("io.github.lanfuli.multi-email.runtime-info");
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CHUNK_PATTERN = /\.index\.cjs\.js$/u;
const SAFE_FAILURE_REASONS = new Set([
  "ARTIFACT_HASH_MISMATCH",
  "ARTIFACT_MISSING",
  "ARTIFACT_NOT_REGULAR",
  "ARTIFACT_SET_MISMATCH",
  "BUILD_MANIFEST_INVALID",
  "BUNDLE_ENTRY_INVALID",
  "BUNDLE_LOAD_FAILED",
  "BUNDLE_START_FAILED",
  "DIST_MISSING",
  "LAZY_CHUNK_INVALID",
  "LAZY_CHUNK_LOAD_FAILED",
  "LAZY_CHUNK_MISSING",
  "NATIVE_RUNTIME_UNAVAILABLE",
  "PACKAGE_BOUNDARY_INVALID",
  "PACKAGE_METADATA_INVALID",
  "VERIFIED_RUNTIME_INFO_INVALID",
]);
const INSTALL_CHANNELS = new Set([
  "codex_plugin_cache",
  "git_checkout",
  "local_package",
  "npm_install",
]);

export class RuntimeIntegrityError extends Error {
  constructor(reason) {
    super("Multi Email runtime integrity verification failed.");
    this.name = "RuntimeIntegrityError";
    this.code = "RUNTIME_INTEGRITY_ERROR";
    this.reason = reason;
  }
}

function fail(reason) {
  throw new RuntimeIntegrityError(reason);
}

async function readJson(absolutePath, reason) {
  try {
    const value = JSON.parse(await readFile(absolutePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(reason);
    return value;
  } catch (error) {
    if (error instanceof RuntimeIntegrityError) throw error;
    fail(reason);
  }
}

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function artifactFiles(directory, root = directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("DIST_MISSING");
  }

  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = portable(path.relative(root, absolute));
    if (entry.isSymbolicLink()) fail("ARTIFACT_NOT_REGULAR");
    if (entry.isDirectory()) {
      files.push(...(await artifactFiles(absolute, root)));
    } else if (entry.isFile()) {
      if (relative !== "build-manifest.json") files.push(relative);
    } else {
      fail("ARTIFACT_NOT_REGULAR");
    }
  }
  return files.sort();
}

function validArtifactName(relative) {
  return (
    typeof relative === "string" &&
    relative.length > 0 &&
    relative === portable(relative) &&
    path.posix.normalize(relative) === relative &&
    !relative.startsWith("../") &&
    !path.posix.isAbsolute(relative)
  );
}

async function digestFile(absolutePath) {
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("ARTIFACT_NOT_REGULAR");
    return createHash("sha256").update(await readFile(absolutePath)).digest("hex");
  } catch (error) {
    if (error instanceof RuntimeIntegrityError) throw error;
    fail("ARTIFACT_MISSING");
  }
}

async function installChannel(pluginRoot) {
  const portableRoot = portable(path.resolve(pluginRoot));
  if (portableRoot.includes("/.codex/plugins/cache/")) return "codex_plugin_cache";
  if (portableRoot.includes("/node_modules/")) return "npm_install";
  try {
    await lstat(path.join(pluginRoot, ".git"));
    return "git_checkout";
  } catch {
    return "local_package";
  }
}

function publicInfo(value) {
  return {
    ok: true,
    appVersion: value.appVersion,
    buildId: value.buildId,
    integrity: "verified",
    artifactsVerified: value.artifactsVerified,
    lazyChunksVerified: value.lazyChunksVerified,
    nativeRuntime: "verified",
    architecture: process.arch,
    installChannel: value.installChannel,
  };
}

export async function verifyRuntimeBundle(
  pluginRoot,
  { nativeLoader = undefined } = {},
) {
  const root = path.resolve(pluginRoot);
  const dist = path.join(root, "dist");
  const moduleLoader = createRequire(path.join(root, "package.json"));
  const packageJson = await readJson(path.join(root, "package.json"), "PACKAGE_METADATA_INVALID");
  const manifest = await readJson(
    path.join(dist, "build-manifest.json"),
    "BUILD_MANIFEST_INVALID",
  );
  const distPackage = await readJson(
    path.join(dist, "package.json"),
    "PACKAGE_BOUNDARY_INVALID",
  );

  if (
    distPackage.type !== "commonjs" ||
    Object.keys(distPackage).length !== 1
  ) {
    fail("PACKAGE_BOUNDARY_INVALID");
  }
  if (
    packageJson.version !== APP_VERSION ||
    manifest.appVersion !== APP_VERSION ||
    manifest.entry !== "server.cjs" ||
    !HASH_PATTERN.test(String(manifest.sourceSha256 || "")) ||
    !manifest.artifacts ||
    typeof manifest.artifacts !== "object" ||
    Array.isArray(manifest.artifacts)
  ) {
    fail("BUILD_MANIFEST_INVALID");
  }

  const recordedFiles = Object.keys(manifest.artifacts).sort();
  if (
    recordedFiles.length === 0 ||
    recordedFiles.some((relative) => !validArtifactName(relative))
  ) {
    fail("BUILD_MANIFEST_INVALID");
  }
  const currentFiles = await artifactFiles(dist);
  if (JSON.stringify(recordedFiles) !== JSON.stringify(currentFiles)) {
    fail("ARTIFACT_SET_MISMATCH");
  }
  for (const relative of recordedFiles) {
    const expected = manifest.artifacts[relative];
    if (!HASH_PATTERN.test(String(expected || ""))) fail("BUILD_MANIFEST_INVALID");
    if ((await digestFile(path.join(dist, relative))) !== expected) {
      fail("ARTIFACT_HASH_MISMATCH");
    }
  }

  const chunkFiles = recordedFiles.filter((relative) => CHUNK_PATTERN.test(relative));
  if (chunkFiles.length === 0) fail("LAZY_CHUNK_MISSING");
  for (const relative of chunkFiles) {
    let chunk;
    try {
      chunk = moduleLoader(path.join(dist, relative));
    } catch {
      fail("LAZY_CHUNK_LOAD_FAILED");
    }
    if (
      !Array.isArray(chunk?.ids) ||
      chunk.ids.length === 0 ||
      !chunk.modules ||
      typeof chunk.modules !== "object" ||
      Object.keys(chunk.modules).length === 0
    ) {
      fail("LAZY_CHUNK_INVALID");
    }
  }

  const nativeFile = `keyring.darwin-${process.arch}.node`;
  if (
    process.platform !== "darwin" ||
    !Array.isArray(manifest.nativeAssets) ||
    !manifest.nativeAssets.includes(nativeFile) ||
    !recordedFiles.includes(nativeFile)
  ) {
    fail("NATIVE_RUNTIME_UNAVAILABLE");
  }
  let nativeRuntime;
  try {
    nativeRuntime = (nativeLoader || moduleLoader)(path.join(dist, nativeFile));
  } catch {
    fail("NATIVE_RUNTIME_UNAVAILABLE");
  }
  if (typeof nativeRuntime?.Entry !== "function") {
    fail("NATIVE_RUNTIME_UNAVAILABLE");
  }

  return publicInfo({
    appVersion: APP_VERSION,
    buildId: manifest.sourceSha256,
    artifactsVerified: recordedFiles.length,
    lazyChunksVerified: chunkFiles.length,
    installChannel: await installChannel(root),
  });
}

export function installVerifiedRuntimeInfo(info) {
  if (
    !info ||
    info.ok !== true ||
    info.appVersion !== APP_VERSION ||
    info.integrity !== "verified" ||
    !HASH_PATTERN.test(String(info.buildId || "")) ||
    !Number.isSafeInteger(info.artifactsVerified) ||
    info.artifactsVerified < 1 ||
    !Number.isSafeInteger(info.lazyChunksVerified) ||
    info.lazyChunksVerified < 1 ||
    info.nativeRuntime !== "verified" ||
    info.architecture !== process.arch ||
    !INSTALL_CHANNELS.has(info.installChannel)
  ) {
    fail("VERIFIED_RUNTIME_INFO_INVALID");
  }
  globalThis[RUNTIME_INFO_SYMBOL] = Object.freeze({
    ok: true,
    appVersion: APP_VERSION,
    buildId: info.buildId,
    integrity: "verified",
    artifactsVerified: info.artifactsVerified,
    lazyChunksVerified: info.lazyChunksVerified,
    nativeRuntime: "verified",
    architecture: process.arch,
    installChannel: info.installChannel,
  });
}

export function currentRuntimeInfo() {
  const verified = globalThis[RUNTIME_INFO_SYMBOL];
  if (verified) return { ...verified };
  return {
    ok: true,
    appVersion: APP_VERSION,
    buildId: null,
    integrity: "unverified",
    artifactsVerified: 0,
    lazyChunksVerified: 0,
    nativeRuntime: "unverified",
    architecture: process.arch,
    installChannel: "development_source",
  };
}

export function safeRuntimeFailure(error) {
  const reason =
    error instanceof RuntimeIntegrityError && SAFE_FAILURE_REASONS.has(error.reason)
      ? error.reason
      : "RUNTIME_CHECK_FAILED";
  return {
    ok: false,
    code: "RUNTIME_INTEGRITY_ERROR",
    reason,
    requiredAction: "reinstall_or_rebuild",
  };
}
