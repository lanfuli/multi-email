#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertVersionContract,
  validateAssistedOnboardingSurface,
} from "./release-integrity.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "multi-email-cold-install-"));
const require = createRequire(import.meta.url);

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

function runExpectFailure(command, args, { cwd = pluginRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status === 0) {
    throw new Error(`Command unexpectedly succeeded: ${command} ${args.join(" ")}`, {
      cause: result.error,
    });
  }
  return `${result.stderr || ""}${result.stdout || ""}`;
}

async function smokePackage(
  packageRoot,
  label,
  {
    command = process.execPath,
    args = [path.join(packageRoot, "scripts", "launch-mcp")],
  } = {},
) {
  await validateAssistedOnboardingSurface(packageRoot, { label });
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const plugin = JSON.parse(
    await readFile(path.join(packageRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const skillSource = await readFile(
    path.join(packageRoot, "skills", "multi-email", "SKILL.md"),
    "utf8",
  );
  const build = JSON.parse(
    await readFile(path.join(packageRoot, "dist", "build-manifest.json"), "utf8"),
  );
  const selfTest = JSON.parse(
    run(
      process.execPath,
      [path.join(packageRoot, "scripts", "multi-email"), "self-test", "--json"],
      { capture: true, cwd: packageRoot },
    ).trim(),
  );
  assertVersionContract(
    {
      packageVersion: metadata.version,
      pluginVersion: plugin.version,
      skillSource,
      runtimeVersion: selfTest.appVersion,
      buildVersion: build.appVersion,
    },
    { label },
  );
  const expectedInstallChannel = {
    "working-tree": "git_checkout",
    "packed-tarball": "local_package",
    "npm-install": "npm_install",
  }[label];
  if (
    selfTest.ok !== true ||
    selfTest.appVersion !== metadata.version ||
    selfTest.integrity !== "verified" ||
    !/^[a-f0-9]{64}$/u.test(selfTest.buildId || "") ||
    selfTest.lazyChunksVerified < 1 ||
    selfTest.nativeRuntime !== "verified" ||
    selfTest.installChannel !== expectedInstallChannel
  ) {
    throw new Error(`${label} package failed its runtime self-test.`);
  }
  const distMetadata = JSON.parse(
    await readFile(path.join(packageRoot, "dist", "package.json"), "utf8"),
  );
  if (distMetadata.type !== "commonjs") {
    throw new Error(`${label} package does not give ncc chunks a CommonJS package boundary.`);
  }
  const chunkFiles = (await readdir(path.join(packageRoot, "dist")))
    .filter((name) => name.endsWith(".index.cjs.js"))
    .sort();
  if (chunkFiles.length === 0) {
    throw new Error(`${label} package contains no ncc dynamic chunks to verify.`);
  }
  for (const file of chunkFiles) {
    const chunk = require(path.join(packageRoot, "dist", file));
    if (
      !Array.isArray(chunk.ids) ||
      chunk.ids.length === 0 ||
      !chunk.modules ||
      typeof chunk.modules !== "object" ||
      Object.keys(chunk.modules).length === 0
    ) {
      throw new Error(`${label} package cannot load bundled chunk ${file} as CommonJS.`);
    }
  }
  const configDirectory = await mkdtemp(path.join(temporaryRoot, `${label}-config-`));
  const configPath = path.join(configDirectory, "missing-config.json");
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
      tools.length !== 15 ||
      !tools.some(({ name }) => name === "mail_get_runtime_info") ||
      !tools.some(({ name }) => name === "mail_list_accounts") ||
      !tools.some(({ name }) => name === "mail_diagnose_accounts")
    ) {
      throw new Error(`${label} package advertised an unexpected MCP tool set.`);
    }
    const runtime = await client.callTool({
      name: "mail_get_runtime_info",
      arguments: {},
    });
    const info = runtime.structuredContent;
    if (
      runtime.isError ||
      info?.ok !== true ||
      info.appVersion !== metadata.version ||
      info.buildId !== selfTest.buildId ||
      info.integrity !== "verified" ||
      info.installChannel !== expectedInstallChannel
    ) {
      throw new Error(`${label} MCP reported an unexpected runtime identity.`);
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
  await access(path.join(extractedPackage, "dist", "package.json"));
  await access(path.join(extractedPackage, "dist", "server.cjs"));
  await access(path.join(extractedPackage, "dist", `keyring.darwin-${process.arch}.node`));
  await access(path.join(extractedPackage, "CONTRIBUTING.md"));
  await access(path.join(extractedPackage, "CODE_OF_CONDUCT.md"));
  await access(path.join(extractedPackage, "assets", "plugin-icon.png"));
  await access(path.join(extractedPackage, "docs", "google-oauth.md"));
  await access(path.join(extractedPackage, "docs", "microsoft-entra.md"));
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
  const help = run(setupExecutable, ["--help"], {
    cwd: consumer,
    capture: true,
  });
  if (
    !help.includes("multi-email setup") ||
    !help.includes("multi-email init") ||
    !help.includes("multi-email doctor [alias] [--json]") ||
    help.includes("npm run setup")
  ) {
    throw new Error("Installed setup help contains unusable consumer commands.");
  }
  const version = run(setupExecutable, ["--version"], {
    cwd: consumer,
    capture: true,
  }).trim();
  if (version !== installedMetadata.version) {
    throw new Error(
      `Installed setup CLI reported ${version || "no version"}, expected ${installedMetadata.version}.`,
    );
  }
  const setupConfigDirectory = path.join(temporaryRoot, "consumer-setup-config");
  await mkdir(setupConfigDirectory);
  const setupConfigPath = path.join(setupConfigDirectory, "config.json");
  const setupEnvironment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    CODEX_MULTI_EMAIL_CONFIG: setupConfigPath,
  };
  const preflight = run(setupExecutable, ["setup"], {
    cwd: consumer,
    capture: true,
    env: setupEnvironment,
  });
  if (
    !preflight.includes("Config\tmissing") ||
    !preflight.includes("multi-email init --google-client-json") ||
    !preflight.includes("multi-email init --microsoft-client-id")
  ) {
    throw new Error("Installed setup preflight did not explain a missing configuration.");
  }
  const missingDoctorLines = run(setupExecutable, ["doctor", "--json"], {
    cwd: consumer,
    capture: true,
    env: setupEnvironment,
  })
    .trim()
    .split("\n");
  if (missingDoctorLines.length !== 1) {
    throw new Error("Installed doctor did not emit one JSON Lines summary for missing config.");
  }
  const missingDoctor = JSON.parse(missingDoctorLines[0]);
  if (
    missingDoctor.type !== "summary" ||
    missingDoctor.status !== "not_configured" ||
    missingDoctor.next_step !==
      "multi-email setup (or node ./scripts/multi-email setup from a Git clone)"
  ) {
    throw new Error("Installed doctor reported an unexpected missing-config state.");
  }
  try {
    await access(setupConfigPath);
    throw new Error("Read-only setup or doctor unexpectedly created a config file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const initialized = run(
    setupExecutable,
    [
      "init",
      "--microsoft-client-id",
      "11111111-2222-3333-4444-555555555555",
      "--microsoft-tenant",
      "organizations",
    ],
    { cwd: consumer, capture: true, env: setupEnvironment },
  );
  if (!initialized.includes("Microsoft OAuth is configured")) {
    throw new Error("Installed setup CLI did not complete Microsoft-only initialization.");
  }
  const configuredPreflight = run(setupExecutable, ["setup"], {
    cwd: consumer,
    capture: true,
    env: setupEnvironment,
  });
  if (
    !configuredPreflight.includes("Config\tready") ||
    !configuredPreflight.includes("Microsoft OAuth\tready") ||
    !configuredPreflight.includes("Accounts\tnone\t0")
  ) {
    throw new Error("Installed setup preflight did not report initialized provider state.");
  }

  const invalidConfigDirectory = path.join(temporaryRoot, "invalid-config-target");
  await mkdir(invalidConfigDirectory);
  const redacted = runExpectFailure(setupExecutable, ["list"], {
    cwd: consumer,
    env: {
      ...setupEnvironment,
      CODEX_MULTI_EMAIL_CONFIG: invalidConfigDirectory,
    },
  });
  if (
    redacted !== "Setup failed: an unexpected local or provider error occurred.\n" ||
    redacted.includes(invalidConfigDirectory)
  ) {
    throw new Error("Installed setup CLI exposed an unknown local error.");
  }
  await smokePackage(installedPackage, "npm-install", {
    command: mcpExecutable,
    args: [],
  });

  process.stdout.write(`Cold install passed (${archiveName}).\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
