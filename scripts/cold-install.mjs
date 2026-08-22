#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "multi-email-cold-install-"));

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

async function writeEmptyConfig(directory) {
  const configPath = path.join(directory, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        safety: {
          maxSearchResults: 25,
          maxWriteBatch: 25,
          maxRecipients: 20,
          sendApprovalTtlSeconds: 300,
        },
        providers: { google: {}, microsoft: { tenant: "organizations" } },
        accounts: [],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return configPath;
}

async function smokePackage(
  packageRoot,
  label,
  {
    command = process.execPath,
    args = [path.join(packageRoot, "scripts", "launch-mcp")],
  } = {},
) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const configDirectory = await mkdtemp(path.join(temporaryRoot, `${label}-config-`));
  const configPath = await writeEmptyConfig(configDirectory);
  const client = new Client({ name: `multi-email-${label}`, version: metadata.version });
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: packageRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      CODEX_MULTI_EMAIL_CONFIG: configPath,
    },
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const server = client.getServerVersion();
    if (server?.name !== "codex-multi-email" || server?.version !== metadata.version) {
      throw new Error(
        `${label} package launched ${server?.name || "unknown"}@${server?.version || "unknown"}, ` +
          `expected codex-multi-email@${metadata.version}.`,
      );
    }
    const { tools } = await client.listTools();
    if (
      tools.length !== 14 ||
      !tools.some(({ name }) => name === "mail_list_accounts") ||
      !tools.some(({ name }) => name === "mail_diagnose_accounts")
    ) {
      throw new Error(`${label} package advertised an unexpected MCP tool set.`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

try {
  await smokePackage(pluginRoot, "working-tree");
  const packDirectory = path.join(temporaryRoot, "pack");
  const extractDirectory = path.join(temporaryRoot, "extract");
  await mkdir(packDirectory);
  await mkdir(extractDirectory);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDirectory, "--silent"], {
    capture: true,
  });
  const archiveName = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (!archiveName) throw new Error("npm pack produced no tarball.");
  const archivePath = path.join(packDirectory, archiveName);
  run("/usr/bin/tar", ["-xzf", archivePath, "-C", extractDirectory]);

  const extractedPackage = path.join(extractDirectory, "package");
  await access(path.join(extractedPackage, "dist", "server.cjs"));
  await access(path.join(extractedPackage, "dist", `keyring.darwin-${process.arch}.node`));
  try {
    await access(path.join(extractedPackage, "test"));
    throw new Error("Published tarball unexpectedly contains tests.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await smokePackage(extractedPackage, "packed-tarball");

  const consumer = path.join(temporaryRoot, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    '{"name":"multi-email-cold-install","private":true,"version":"1.0.0"}\n',
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", archivePath],
    { cwd: consumer },
  );
  const installedPackage = path.join(consumer, "node_modules", "codex-multi-email");
  const installedMetadata = JSON.parse(
    await readFile(path.join(installedPackage, "package.json"), "utf8"),
  );
  if (installedMetadata.name !== "codex-multi-email") {
    throw new Error("Installed package metadata is incorrect.");
  }
  const executableDirectory = path.join(consumer, "node_modules", ".bin");
  const setupExecutable = path.join(executableDirectory, "multi-email");
  const mcpExecutable = path.join(executableDirectory, "multi-email-mcp");
  await access(setupExecutable, fsConstants.X_OK);
  await access(mcpExecutable, fsConstants.X_OK);
  run(setupExecutable, ["--help"], {
    cwd: consumer,
  });
  await smokePackage(installedPackage, "npm-install", {
    command: mcpExecutable,
    args: [],
  });

  process.stdout.write(`Cold install passed (${archiveName}).\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
