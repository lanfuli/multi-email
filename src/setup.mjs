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
  loadConfigForMicrosoftRepair,
  saveConfig,
} from "./config.mjs";
import { APP_VERSION } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";
import { KeychainStore } from "./keychain.mjs";
import {
  googleProviderConfigured,
  microsoftProviderConfigured,
  normalizeMicrosoftClientId,
  normalizeMicrosoftTenant,
} from "./validation.mjs";

const HELP = `Multi Email setup

Usage:
  multi-email init --google-client-json <desktop-oauth.json> [--microsoft-client-id <guid>] [--microsoft-tenant <tenant>]
  multi-email init --microsoft-client-id <guid> [--microsoft-tenant <tenant>]
  multi-email add-account <alias> <email> <google|microsoft>
  multi-email set-microsoft-client <guid> [--microsoft-tenant <tenant>]
  multi-email auth <alias>
  multi-email doctor [alias]
  multi-email logout <alias> --confirm
  multi-email revoke <alias> --confirm
  multi-email list
  multi-email --version

Notes:
  - From a Git clone, replace 'multi-email' with 'node ./scripts/multi-email'.
  - init requires at least one Google or Microsoft OAuth client option.
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
    fail(
      "Invalid arguments. Run 'multi-email --help' (or 'node ./scripts/multi-email --help' from a Git clone) for usage.",
    );
  }
}

async function loadConfigOrEmpty(configPath, { repairMicrosoft = false } = {}) {
  try {
    return await (repairMicrosoft
      ? loadConfigForMicrosoftRepair(configPath)
      : loadConfig(configPath));
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

async function initCommand({ values, positionals, configPath, output }) {
  requireNoExtraPositionals(positionals, 0);
  const googleClientPath = values["google-client-json"];
  const microsoftClientIdValue = values["microsoft-client-id"];
  if (!googleClientPath && !microsoftClientIdValue) {
    fail(
      "init requires --google-client-json, --microsoft-client-id, or both.",
    );
  }
  if (values["microsoft-tenant"] && !microsoftClientIdValue) {
    fail("--microsoft-tenant requires --microsoft-client-id during init.");
  }

  const google = googleClientPath
    ? await readGoogleDesktopClient(googleClientPath)
    : undefined;
  const microsoftClientId = microsoftClientIdValue
    ? normalizeMicrosoftClientId(microsoftClientIdValue)
    : undefined;
  const microsoftTenant = microsoftClientId
    ? normalizeMicrosoftTenant(values["microsoft-tenant"] || "organizations")
    : undefined;
  const config = await loadConfigOrEmpty(configPath, {
    repairMicrosoft: Boolean(microsoftClientId),
  });
  if (google) config.providers.google = google;

  if (microsoftClientId) {
    config.providers.microsoft = {
      clientId: microsoftClientId,
      tenant: microsoftTenant,
    };
  }

  const saved = await saveConfig(config, configPath);
  output(`Initialized Multi Email configuration at ${configPath}.`);
  const googleConfigured = googleProviderConfigured(saved.providers.google);
  const microsoftConfigured = microsoftProviderConfigured(saved.providers.microsoft);
  if (googleConfigured && microsoftConfigured) {
    output("Google and Microsoft OAuth clients are configured.");
  } else if (googleConfigured) {
    output("Google OAuth is configured. Microsoft can be added later with set-microsoft-client.");
  } else if (microsoftConfigured) {
    output("Microsoft OAuth is configured. Google can be added later with init --google-client-json.");
  }
}

async function addAccountCommand({ positionals, configPath, output }) {
  requireNoExtraPositionals(positionals, 3);
  const [alias, email, providerValue] = positionals;
  const provider = String(providerValue || "").toLowerCase();
  if (provider !== "google" && provider !== "microsoft") {
    fail("Account provider must be 'google' or 'microsoft'.");
  }
  const config = await loadConfig(configPath);
  if (provider === "google" && !googleProviderConfigured(config.providers.google)) {
    fail(
      "Google OAuth is not configured. Run 'multi-email init --google-client-json <desktop-oauth.json>' (or use 'node ./scripts/multi-email init ...' from a Git clone) before adding a Google account.",
      "PROVIDER_NOT_CONFIGURED",
    );
  }
  if (
    provider === "microsoft" &&
    !microsoftProviderConfigured(config.providers.microsoft)
  ) {
    fail(
      "Microsoft OAuth is not configured. Run 'multi-email set-microsoft-client <application-guid>' (or use 'node ./scripts/multi-email set-microsoft-client ...' from a Git clone) before adding a Microsoft account.",
      "PROVIDER_NOT_CONFIGURED",
    );
  }
  config.accounts.push({ alias, email, provider });
  const saved = await saveConfig(config, configPath);
  const added = findAccount(saved, alias);
  output(`Added '${added.alias}' (${added.provider}, ${added.email}).`);
  output(
    `Next: multi-email auth ${added.alias} (or node ./scripts/multi-email auth ${added.alias} from a Git clone).`,
  );
}

async function setMicrosoftClientCommand({ values, positionals, configPath, output }) {
  requireNoExtraPositionals(positionals, 1);
  const clientId = normalizeMicrosoftClientId(positionals[0]);

  const config = await loadConfigForMicrosoftRepair(configPath);
  config.providers.microsoft = {
    clientId,
    tenant: normalizeMicrosoftTenant(
      values["microsoft-tenant"] || config.providers.microsoft?.tenant || "organizations",
    ),
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
      version: { type: "boolean", short: "V" },
    },
  });
}

export async function run(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console.log;
  const configPath = dependencies.configPath || defaultConfigPath();
  const credentialStore = dependencies.credentialStore || new KeychainStore();
  const providerFactory = dependencies.providerFactory || instantiateProvider;
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    if (String(error?.code || "").startsWith("ERR_PARSE_ARGS_")) {
      fail(
        "Invalid arguments. Run 'multi-email --help' (or 'node ./scripts/multi-email --help' from a Git clone) for usage.",
      );
    }
    throw error;
  }
  const [command, ...positionals] = parsed.positionals;

  if (parsed.values.version) {
    output(APP_VERSION);
    return;
  }

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
      fail(
        `Unknown command '${command}'. Run 'multi-email --help' (or 'node ./scripts/multi-email --help' from a Git clone) for usage.`,
      );
  }
}

export function formatSetupError(error) {
  if (error instanceof MultiEmailError) {
    const code = error.code ? ` [${error.code}]` : "";
    return `Setup failed${code}: ${error.message}`;
  }
  return "Setup failed: an unexpected local or provider error occurred.";
}

export async function runSetupCli(args = process.argv.slice(2), dependencies = {}) {
  const errorOutput = dependencies.errorOutput || console.error;
  const setExitCode =
    dependencies.setExitCode ||
    ((code) => {
      process.exitCode = code;
    });
  try {
    await run(args, dependencies);
    return true;
  } catch (error) {
    errorOutput(formatSetupError(error));
    setExitCode(1);
    return false;
  }
}

const invokedAsScript =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  void runSetupCli();
}
