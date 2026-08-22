#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  defaultConfigPath,
  emptyConfig,
  findAccount,
  loadConfig,
  saveConfig,
} from "./config.mjs";
import { MultiEmailError } from "./errors.mjs";
import { KeychainStore } from "./keychain.mjs";

const HELP = `Multi Email setup

Usage:
  npm run setup -- init --google-client-json <desktop-oauth.json> [--microsoft-client-id <id>] [--microsoft-tenant <tenant>]
  npm run setup -- add-account <alias> <email> <google|microsoft>
  npm run setup -- set-microsoft-client <client-id> [--microsoft-tenant <tenant>]
  npm run setup -- auth <alias>
  npm run setup -- doctor [alias]
  npm run setup -- logout <alias> --confirm
  npm run setup -- revoke <alias> --confirm
  npm run setup -- list

Notes:
  - Aliases are lowercase identifiers used by every mail tool.
  - OAuth tokens are stored in macOS Keychain and are never printed.
  - The config path defaults to ~/.config/codex-multi-email/config.json.
  - doctor may contact the provider but never writes or migrates credentials.
  - logout removes local credentials. revoke also removes the provider grant where supported.
`;

function fail(message, code = "INVALID_ARGUMENT") {
  throw new MultiEmailError(message, code);
}

function requireNoExtraPositionals(positionals, expected) {
  if (positionals.length !== expected) {
    fail("Invalid arguments. Run 'npm run setup -- --help' for usage.");
  }
}

async function loadConfigOrEmpty(configPath) {
  try {
    return await loadConfig(configPath);
  } catch (error) {
    if (error?.code === "NOT_CONFIGURED") return emptyConfig();
    throw error;
  }
}

export async function readGoogleDesktopClient(filePath) {
  if (!filePath) {
    fail("init requires --google-client-json with a Google Desktop OAuth client file.");
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail("The Google OAuth client file is not valid JSON.", "INVALID_GOOGLE_CLIENT");
    }
    if (error?.code === "ENOENT") {
      fail("The Google OAuth client file does not exist.", "INVALID_GOOGLE_CLIENT");
    }
    throw error;
  }

  const installed = parsed?.installed;
  if (!installed?.client_id || !installed?.client_secret) {
    fail(
      "The Google file must be a Desktop app OAuth client JSON (the 'installed' client type).",
      "INVALID_GOOGLE_CLIENT",
    );
  }

  return {
    clientId: String(installed.client_id),
    clientSecret: String(installed.client_secret),
  };
}

async function instantiateProvider(provider, config, credentialStore) {
  if (provider === "google") {
    const { GmailProvider } = await import("./providers/gmail.mjs");
    return new GmailProvider({ config, credentialStore });
  }
  if (provider === "microsoft") {
    const { MicrosoftProvider } = await import("./providers/microsoft.mjs");
    return new MicrosoftProvider({ config, credentialStore });
  }
  fail(`Unsupported provider '${provider}'.`);
}

function optionalTenant(value) {
  const tenant = value ? String(value).trim() : "organizations";
  if (!tenant || /[\s\r\n/]/.test(tenant)) {
    fail("Microsoft tenant must be 'organizations', 'common', a tenant ID, or a tenant domain.");
  }
  return tenant;
}

async function initCommand({ values, positionals, configPath, output }) {
  requireNoExtraPositionals(positionals, 0);
  const google = await readGoogleDesktopClient(values["google-client-json"]);
  const config = await loadConfigOrEmpty(configPath);
  config.providers.google = google;

  if (values["microsoft-client-id"]) {
    config.providers.microsoft = {
      clientId: String(values["microsoft-client-id"]).trim(),
      tenant: optionalTenant(values["microsoft-tenant"]),
    };
  } else if (values["microsoft-tenant"]) {
    fail("--microsoft-tenant requires --microsoft-client-id during init.");
  }

  await saveConfig(config, configPath);
  output(`Initialized Multi Email configuration at ${configPath}.`);
  output(
    values["microsoft-client-id"]
      ? "Google and Microsoft OAuth clients are configured."
      : "Google OAuth is configured. Microsoft can be added later with set-microsoft-client.",
  );
}

async function addAccountCommand({ positionals, configPath, output }) {
  requireNoExtraPositionals(positionals, 3);
  const [alias, email, provider] = positionals;
  const config = await loadConfig(configPath);
  config.accounts.push({ alias, email, provider });
  const saved = await saveConfig(config, configPath);
  const added = findAccount(saved, alias);
  output(`Added '${added.alias}' (${added.provider}, ${added.email}).`);
  output(`Next: npm run setup -- auth ${added.alias}`);
}

async function setMicrosoftClientCommand({ values, positionals, configPath, output }) {
  requireNoExtraPositionals(positionals, 1);
  const clientId = String(positionals[0] || "").trim();
  if (!clientId || /[\s\r\n]/.test(clientId)) {
    fail("set-microsoft-client requires a valid public client application ID.");
  }

  const config = await loadConfig(configPath);
  config.providers.microsoft = {
    clientId,
    tenant: optionalTenant(values["microsoft-tenant"] || config.providers.microsoft?.tenant),
  };
  await saveConfig(config, configPath);
  output("Microsoft OAuth client configuration updated.");
}

async function authCommand({ positionals, configPath, output, credentialStore, providerFactory }) {
  requireNoExtraPositionals(positionals, 1);
  const config = await loadConfig(configPath);
  const account = findAccount(config, positionals[0]);
  const provider = await providerFactory(account.provider, config, credentialStore);
  const result = await provider.authorize(account, { onInstruction: output });
  output(`Authorized '${result.alias}' as ${result.email} with ${result.provider}.`);
}

async function doctorCommand({ positionals, configPath, output, credentialStore, providerFactory }) {
  if (positionals.length > 1) {
    fail("doctor accepts at most one account alias.");
  }
  const config = await loadConfig(configPath);
  const accounts = positionals.length ? [findAccount(config, positionals[0])] : config.accounts;
  if (accounts.length === 0) {
    output("No accounts configured.");
    return;
  }

  for (const account of accounts) {
    const provider = await providerFactory(account.provider, config, credentialStore);
    output(JSON.stringify(await provider.diagnose(account)));
  }
}

function requireConfirmation(values, command) {
  if (!values.confirm) {
    fail(`${command} requires --confirm because it changes authorization state.`, "CONFIRMATION_REQUIRED");
  }
}

async function logoutCommand(context) {
  const { values, positionals, configPath, output, credentialStore, providerFactory } = context;
  requireNoExtraPositionals(positionals, 1);
  requireConfirmation(values, "logout");
  const config = await loadConfig(configPath);
  const account = findAccount(config, positionals[0]);
  const provider = await providerFactory(account.provider, config, credentialStore);
  output(JSON.stringify(await provider.logout(account)));
}

async function revokeCommand(context) {
  const { values, positionals, configPath, output, credentialStore, providerFactory } = context;
  requireNoExtraPositionals(positionals, 1);
  requireConfirmation(values, "revoke");
  const config = await loadConfig(configPath);
  const account = findAccount(config, positionals[0]);
  const provider = await providerFactory(account.provider, config, credentialStore);
  output(JSON.stringify(await provider.revoke(account)));
}

async function listCommand({ positionals, configPath, output }) {
  requireNoExtraPositionals(positionals, 0);
  const config = await loadConfig(configPath);
  if (config.accounts.length === 0) {
    output("No accounts configured.");
    return;
  }

  output("ALIAS\tPROVIDER\tEMAIL");
  for (const account of config.accounts) {
    output(`${account.alias}\t${account.provider}\t${account.email}`);
  }
}

export function parseCliArgs(args) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "google-client-json": { type: "string" },
      "microsoft-client-id": { type: "string" },
      "microsoft-tenant": { type: "string" },
      confirm: { type: "boolean" },
    },
  });
}

export async function run(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console.log;
  const configPath = dependencies.configPath || defaultConfigPath();
  const credentialStore = dependencies.credentialStore || new KeychainStore();
  const providerFactory = dependencies.providerFactory || instantiateProvider;
  const parsed = parseCliArgs(args);
  const [command, ...positionals] = parsed.positionals;

  if (parsed.values.help || !command) {
    output(HELP.trimEnd());
    return;
  }

  const context = {
    values: parsed.values,
    positionals,
    configPath,
    output,
    credentialStore,
    providerFactory,
  };
  switch (command) {
    case "init":
      return initCommand(context);
    case "add-account":
      return addAccountCommand(context);
    case "set-microsoft-client":
      return setMicrosoftClientCommand(context);
    case "auth":
      return authCommand(context);
    case "doctor":
      return doctorCommand(context);
    case "logout":
      return logoutCommand(context);
    case "revoke":
      return revokeCommand(context);
    case "list":
      return listCommand(context);
    default:
      fail(`Unknown command '${command}'. Run 'npm run setup -- --help' for usage.`);
  }
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  run().catch((error) => {
    if (error instanceof MultiEmailError) {
      const code = error.code ? ` [${error.code}]` : "";
      console.error(`Setup failed${code}: ${error.message}`);
    } else {
      // Provider and parser errors can carry request context. Do not risk printing
      // authorization codes, tokens, or client credentials from an unknown error.
      console.error("Setup failed: an unexpected local or provider error occurred.");
    }
    process.exitCode = 1;
  });
}
