#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../src/constants.mjs";
import {
  artifactFiles,
  assertVersionContract,
  buildInputFiles,
  digestFile,
  digestFiles,
} from "./release-integrity.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(pluginRoot, "dist");
const nccCli = path.join(pluginRoot, "node_modules", "@vercel", "ncc", "dist", "ncc", "cli.js");
const keyringVersion = "1.3.0";
const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
const plugin = JSON.parse(
  await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
);
const skillSource = await readFile(
  path.join(pluginRoot, "skills", "multi-email", "SKILL.md"),
  "utf8",
);
assertVersionContract(
  {
    packageVersion: packageJson.version,
    pluginVersion: plugin.version,
    skillSource,
    runtimeVersion: APP_VERSION,
  },
  { label: "Build source" },
);
const packageLock = JSON.parse(
  await readFile(path.join(pluginRoot, "package-lock.json"), "utf8"),
);
const nativeAssets = [
  {
    file: "keyring.darwin-arm64.node",
    packageName: "@napi-rs/keyring-darwin-arm64",
    lockPath: "node_modules/@napi-rs/keyring-darwin-arm64",
    architecturePattern: /\barm64\b/,
  },
  {
    file: "keyring.darwin-x64.node",
    packageName: "@napi-rs/keyring-darwin-x64",
    lockPath: "node_modules/@napi-rs/keyring-darwin-x64",
    architecturePattern: /\bx86_64\b/,
  },
];

function run(command, args, { capture = false, cwd = pluginRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
      { cause: result.error },
    );
  }
  return result.stdout || "";
}

async function fetchNativeAsset(asset, buildDirectory) {
  const locked = packageLock.packages?.[asset.lockPath];
  if (
    locked?.version !== keyringVersion ||
    typeof locked?.integrity !== "string" ||
    !locked.integrity.startsWith("sha512-")
  ) {
    throw new Error(`Missing exact lockfile integrity for ${asset.packageName}@${keyringVersion}.`);
  }
  const packageSpec = `${asset.packageName}@${keyringVersion}`;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "multi-email-native-"));
  try {
    const npmEnvironment = { ...process.env };
    for (const key of Object.keys(npmEnvironment)) {
      if (["npm_config_dry_run", "npm_config_json", "npm_config_pack_destination"].includes(
        key.toLowerCase(),
      )) {
        delete npmEnvironment[key];
      }
    }
    run(
      "npm",
      [
        "pack",
        packageSpec,
        "--pack-destination",
        temporaryDirectory,
        "--ignore-scripts",
        "--silent",
      ],
      { capture: true, env: npmEnvironment },
    );
    const archives = (await readdir(temporaryDirectory)).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) {
      throw new Error(`npm pack produced ${archives.length} archives for ${packageSpec}.`);
    }
    const archivePath = path.join(temporaryDirectory, archives[0]);
    const archiveBytes = await readFile(archivePath);
    const actualIntegrity = `sha512-${createHash("sha512")
      .update(archiveBytes)
      .digest("base64")}`;
    if (actualIntegrity !== locked.integrity) {
      throw new Error(`Registry tarball integrity mismatch for ${packageSpec}.`);
    }

    const extracted = path.join(temporaryDirectory, "extracted");
    await mkdir(extracted);
    run("/usr/bin/tar", ["-xzf", archivePath, "-C", extracted]);
    await copyFile(
      path.join(extracted, "package", asset.file),
      path.join(buildDirectory, asset.file),
    );

    const fileDescription = run("/usr/bin/file", [path.join(buildDirectory, asset.file)], {
      capture: true,
    });
    if (!fileDescription.includes("Mach-O") || !asset.architecturePattern.test(fileDescription)) {
      throw new Error(`Native asset ${asset.file} has an unexpected architecture.`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const buildDirectory = await mkdtemp(path.join(pluginRoot, ".multi-email-dist-"));
try {
  run(process.execPath, [
    nccCli,
    "build",
    path.join(pluginRoot, "scripts", "release-entry.cjs"),
    "-o",
    buildDirectory,
    "--no-cache",
    "--license",
    "licenses.txt",
  ]);

  await rename(path.join(buildDirectory, "index.cjs"), path.join(buildDirectory, "server.cjs"));

  // ncc emits dynamically loaded CommonJS chunks with a .js suffix. The
  // package root is ESM, so give dist its own CommonJS package boundary or
  // Node can classify those chunks as ESM and break their lazy loading.
  await writeFile(
    path.join(buildDirectory, "package.json"),
    `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
  );

  for (const asset of nativeAssets) {
    await fetchNativeAsset(asset, buildDirectory);
    const metadata = await stat(path.join(buildDirectory, asset.file));
    if (metadata.size < 100_000) {
      throw new Error(`Native asset ${asset.file} is unexpectedly small.`);
    }
  }

  const buildInputs = await buildInputFiles(pluginRoot);
  const artifacts = {};
  for (const file of await artifactFiles(buildDirectory)) {
    artifacts[file] = await digestFile(path.join(buildDirectory, file));
  }

  await writeFile(
    path.join(buildDirectory, "build-manifest.json"),
    `${JSON.stringify(
      {
        entry: "server.cjs",
        appVersion: packageJson.version,
        ncc: "0.45.0",
        keyring: keyringVersion,
        sourceSha256: await digestFiles(pluginRoot, buildInputs),
        artifacts,
        nativeAssets: nativeAssets.map(({ file }) => file),
      },
      null,
      2,
    )}\n`,
  );

  // Keep the last known-good bundle intact until every new artifact and digest
  // has been produced and checked. The final same-filesystem rename is atomic.
  const previousDirectory = path.join(
    pluginRoot,
    `.multi-email-dist-previous-${randomUUID()}`,
  );
  try {
    await rename(distDirectory, previousDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(buildDirectory, distDirectory);
  } catch (error) {
    try {
      await rename(previousDirectory, distDirectory);
    } catch {
      // Preserve the original replacement failure if rollback is unavailable.
    }
    throw error;
  }
  await rm(previousDirectory, { recursive: true, force: true });
} finally {
  await rm(buildDirectory, { recursive: true, force: true });
}

process.stdout.write("Built dist/server.cjs with macOS arm64 and x64 Keychain assets.\n");
