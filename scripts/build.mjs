#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(pluginRoot, "dist");
const nccCli = path.join(pluginRoot, "node_modules", "@vercel", "ncc", "dist", "ncc", "cli.js");
const keyringVersion = "1.3.0";
const nativeAssets = [
  {
    file: "keyring.darwin-arm64.node",
    package: `@napi-rs/keyring-darwin-arm64@${keyringVersion}`,
  },
  {
    file: "keyring.darwin-x64.node",
    package: `@napi-rs/keyring-darwin-x64@${keyringVersion}`,
  },
];

function run(command, args, { capture = false, cwd = pluginRoot } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
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

async function preserveExistingNativeAssets() {
  const preserved = new Map();
  for (const asset of nativeAssets) {
    try {
      preserved.set(asset.file, await readFile(path.join(distDirectory, asset.file)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return preserved;
}

async function fetchNativeAsset(asset) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "multi-email-native-"));
  try {
    run(
      "npm",
      [
        "pack",
        asset.package,
        "--pack-destination",
        temporaryDirectory,
        "--ignore-scripts",
        "--silent",
      ],
      { capture: true },
    );
    const archive = (await readdir(temporaryDirectory)).find((name) => name.endsWith(".tgz"));
    if (!archive) throw new Error(`npm pack produced no archive for ${asset.package}.`);

    const extracted = path.join(temporaryDirectory, "extracted");
    await mkdir(extracted);
    run("/usr/bin/tar", ["-xzf", path.join(temporaryDirectory, archive), "-C", extracted]);
    await copyFile(
      path.join(extracted, "package", asset.file),
      path.join(distDirectory, asset.file),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const preserved = await preserveExistingNativeAssets();
await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

run(process.execPath, [
  nccCli,
  "build",
  path.join(pluginRoot, "scripts", "release-entry.cjs"),
  "-o",
  distDirectory,
  "--no-cache",
  "--license",
  "licenses.txt",
]);

await rename(path.join(distDirectory, "index.cjs"), path.join(distDirectory, "server.cjs"));

for (const [file, contents] of preserved) {
  await writeFile(path.join(distDirectory, file), contents);
}

for (const asset of nativeAssets) {
  try {
    await stat(path.join(distDirectory, asset.file));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fetchNativeAsset(asset);
  }
  const metadata = await stat(path.join(distDirectory, asset.file));
  if (metadata.size < 100_000) {
    throw new Error(`Native asset ${asset.file} is unexpectedly small.`);
  }
}

await writeFile(
  path.join(distDirectory, "build-manifest.json"),
  `${JSON.stringify(
    {
      entry: "server.cjs",
      ncc: "0.45.0",
      keyring: keyringVersion,
      nativeAssets: nativeAssets.map(({ file }) => file),
    },
    null,
    2,
  )}\n`,
);

process.stdout.write("Built dist/server.cjs with macOS arm64 and x64 Keychain assets.\n");
