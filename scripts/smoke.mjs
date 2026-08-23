#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(pluginRoot, "scripts", "launch-mcp");
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "multi-email-smoke-"));
const configPath = path.join(tempDirectory, "config.json");
const packageJson = JSON.parse(
  await readFile(path.join(pluginRoot, "package.json"), "utf8"),
);
let client;

try {
  client = new Client({ name: "multi-email-smoke", version: packageJson.version });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: pluginRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      CODEX_MULTI_EMAIL_CONFIG: configPath,
    },
    stderr: "inherit",
  });

  await client.connect(transport);
  const server = client.getServerVersion();
  if (server?.name !== "codex-multi-email" || server?.version !== packageJson.version) {
    throw new Error(
      `MCP server reported ${server?.name || "unknown"}@${server?.version || "unknown"}; ` +
        `expected codex-multi-email@${packageJson.version}.`,
    );
  }
  const { tools } = await client.listTools();
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("MCP server started but advertised no tools.");
  }
  const names = tools.map((tool) => tool.name);
  if (
    !names.includes("mail_get_runtime_info") ||
    !names.includes("mail_list_accounts")
  ) {
    throw new Error("MCP server did not advertise its runtime and account tools.");
  }
  const runtime = await client.callTool({
    name: "mail_get_runtime_info",
    arguments: {},
  });
  const info = runtime.structuredContent;
  if (
    runtime.isError ||
    info?.ok !== true ||
    info.appVersion !== packageJson.version ||
    info.integrity !== "verified" ||
    !/^[a-f0-9]{64}$/u.test(info.buildId || "") ||
    info.installChannel !== "git_checkout"
  ) {
    throw new Error("MCP server did not report a verified working-tree runtime.");
  }
  process.stdout.write(`MCP smoke passed (${tools.length} tools).\n`);
} finally {
  if (client) await client.close().catch(() => {});
  await rm(tempDirectory, { recursive: true, force: true });
}
