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
import {
  diagnosticRecord,
  doctorSummaryRecord,
  executableCommand,
  providerSetupCommand,
  unexpectedDiagnosticRecord,
} from "./connection-diagnostic.mjs";
import { APP_VERSION, GOOGLE_SCOPES, MICROSOFT_SCOPES } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";
import { KeychainStore } from "./keychain.mjs";
import { normalizeOAuthBrowser } from "./oauth-browser.mjs";
import {
  googleProviderConfigured,
  microsoftProviderConfigured,
  normalizeMicrosoftClientId,
  normalizeMicrosoftTenant,
} from "./validation.mjs";

const HELP = `Multi Email setup

Usage:
  multi-email setup
  multi-email init --google-client-json <desktop-oauth.json> [--microsoft-client-id <guid>] [--microsoft-tenant <tenant>] [--confirm]
  multi-email init --microsoft-client-id <guid> [--microsoft-tenant <tenant>]
  multi-email add-account <alias> <email> <google|microsoft>
  multi-email set-microsoft-client <guid> [--microsoft-tenant <tenant>]
  multi-email auth <alias> [--browser <default|safari|chrome>] [--force]
  multi-email doctor [alias] [--json]
  multi-email self-test [--json]
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
  - setup is a non-interactive, read-only preflight and never reads credentials.
  - doctor may contact the provider but never writes or migrates credentials.
  - doctor --json emits one stable JSON object per line.
  - self-test does not read config, Keychain, providers, or mailbox data.
  - logout removes local credentials. revoke also removes the provider grant where supported.
`;

const COMMAND_OPTIONS = Object.freeze({
  setup: new Set(),
  init: new Set(["google-client-json", "microsoft-client-id", "microsoft-tenant", "confirm"]),
  "add-account": new Set(),
  "set-microsoft-client": new Set(["microsoft-tenant"]),
  auth: new Set(["browser", "force"]),
  doctor: new Set(["json"]),
  logout: new Set(["confirm"]),
  revoke: new Set(["confirm"]),
  list: new Set(),
});

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

async function inspectConfiguration(configPath) {
  try {
    return { config: await loadConfig(configPath), status: "ready" };
  } catch (error) {
    if (error?.code === "NOT_CONFIGURED") {
      return { config: emptyConfig(), status: "missing" };
    }
    if (error?.code !== "INVALID_CONFIG") throw error;
    return {
      config: await loadConfigForMicrosoftRepair(configPath),
      status: "microsoft_repair_required",
    };
  }
}

function providerReady(config, provider) {
  return provider === "google"
    ? googleProviderConfigured(config.providers.google)
    : microsoftProviderConfigured(config.providers.microsoft);
}

function nextAddAccountCommand(provider) {
  return executableCommand(`multi-email add-account <alias> <email> ${provider}`);
}

function setupNextCommands({ config, status }) {
  if (status === "microsoft_repair_required") {
    return [providerSetupCommand("microsoft")];
  }

  const missingAccountProviders = [];
  for (const account of config.accounts) {
    if (
      !providerReady(config, account.provider) &&
      !missingAccountProviders.includes(account.provider)
    ) {
      missingAccountProviders.push(account.provider);
    }
  }
  if (missingAccountProviders.length) {
    return missingAccountProviders.map((provider) => providerSetupCommand(provider));
  }

  if (config.accounts.length) return [executableCommand("multi-email doctor")];

  const configuredProviders = ["google", "microsoft"].filter((provider) =>
    providerReady(config, provider),
  );
  if (configuredProviders.length) {
    return configuredProviders.map((provider) => nextAddAccountCommand(provider));
  }

  return [
    providerSetupCommand("google", { configExists: status !== "missing" }),
    providerSetupCommand("microsoft", { configExists: status !== "missing" }),
  ];
}

function safeCell(value) {
  return String(value ?? "-").replace(/[\u0000-\u001f\u007f]/gu, "?");
}

function assertCommandOptions(command, values) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return;
  for (const option of Object.keys(values)) {
    if (option === "help" || option === "version" || allowed.has(option)) continue;
    fail(
      `Option '--${option}' is not valid for '${command}'. Run 'multi-email --help' (or 'node ./scripts/multi-email --help' from a Git clone) for usage.`,
    );
  }
}

async function setupCommand({ positionals, configPath, configLocation, output }) {
  requireNoExtraPositionals(positionals, 0);
  const state = await inspectConfiguration(configPath);
  const googleReady = providerReady(state.config, "google");
  const microsoftReady = providerReady(state.config, "microsoft");
  const nextCommands = setupNextCommands(state);

  output("Multi Email setup status");
  output("ITEM\tSTATUS\tDETAIL");
  output(`Version\tready\t${safeCell(APP_VERSION)}`);
  output(`Config\t${safeCell(state.status)}\t${configLocation}`);
  output(
    `Google OAuth\t${googleReady ? "ready" : "not_configured"}\t${
      googleReady ? "client configured" : "client required"
    }`,
  );
  output(
    `Microsoft OAuth\t${microsoftReady ? "ready" : "not_configured"}\t${
      microsoftReady ? "client configured" : "client required"
    }`,
  );
  output(
    `Accounts\t${state.config.accounts.length ? "configured" : "none"}\t${state.config.accounts.length}`,
  );
  output(`Next: ${nextCommands[0]}`);
  for (const alternative of nextCommands.slice(1)) {
    output(`Alternative: ${alternative}`);
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
  const clientId = typeof installed?.client_id === "string"
    ? installed.client_id.trim()
    : "";
  const clientSecret = typeof installed?.client_secret === "string"
    ? installed.client_secret.trim()
    : "";
  if (!clientId || !clientSecret) {
    fail(
      "The Google file must be a Desktop app OAuth client JSON (the 'installed' client type).",
      "INVALID_GOOGLE_CLIENT",
    );
  }

  return {
    clientId,
    clientSecret,
  };
}

function googleAliases(config) {
  return config.accounts
    .filter((account) => account.provider === "google")
    .map((account) => account.alias);
}

function isGoogleClientReplacement(config, google) {
  const existingClientId = String(config.providers.google?.clientId || "").trim();
  return Boolean(existingClientId && existingClientId !== google.clientId);
}

function outputGoogleClientReplacementImpact(output, aliases) {
  output(
    `Google OAuth client replacement affects ${aliases.length} configured Google alias${aliases.length === 1 ? "" : "es"}.`,
  );
  if (!aliases.length) {
    output("No Google aliases currently require reauthorization.");
    return;
  }
  output("Every affected Google alias must be authorized again and then diagnosed:");
  for (const alias of aliases) {
    output(`  ${executableCommand(`multi-email auth ${alias} --force`)}`);
    output(`  ${executableCommand(`multi-email doctor ${alias} --json`)}`);
  }
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
  const replacingGoogleClient = Boolean(google && isGoogleClientReplacement(config, google));
  const affectedGoogleAliases = replacingGoogleClient ? googleAliases(config) : [];
  if (replacingGoogleClient && !values.confirm) {
    outputGoogleClientReplacementImpact(output, affectedGoogleAliases);
    const reauthorizationImpact = affectedGoogleAliases.length
      ? `After replacement, all ${affectedGoogleAliases.length} affected Google aliases require 'multi-email auth <alias> --force' followed by 'multi-email doctor <alias> --json'.`
      : "This replacement affects 0 configured Google aliases, so none currently require reauthorization.";
    fail(
      `Refusing to replace the configured Google OAuth client without --confirm. ${reauthorizationImpact} Re-run the same init command with --confirm only after reviewing this impact.`,
      "GOOGLE_CLIENT_REPLACEMENT_CONFIRMATION_REQUIRED",
    );
  }
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
  if (replacingGoogleClient) {
    output("Google OAuth client replacement confirmed and saved.");
    outputGoogleClientReplacementImpact(output, affectedGoogleAliases);
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

function authorizationScopes(provider) {
  return provider === "google" ? GOOGLE_SCOPES : MICROSOFT_SCOPES;
}

function diagnosticIsHealthy(diagnostic) {
  return (
    diagnostic?.status === "ok" &&
    diagnostic?.credential_present === true &&
    diagnostic?.token_valid === true &&
    diagnostic?.identity_verified === true &&
    diagnostic?.scopes_valid === true
  );
}

const AUTHORIZABLE_HEALTH_STATUSES = new Set([
  "identity_mismatch",
  "insufficient_scopes",
  "invalid_credential",
  "not_authorized",
  "reauthorization_required",
]);

async function authCommand({
  values,
  positionals,
  configPath,
  output,
  credentialStore,
  providerFactory,
}) {
  requireNoExtraPositionals(positionals, 1);
  const config = await loadConfig(configPath);
  const account = findAccount(config, positionals[0]);
  const browser = normalizeOAuthBrowser(values.browser || "default");
  const provider = await providerFactory(account.provider, config, credentialStore);
  let diagnostic;
  try {
    diagnostic = await provider.diagnose(account);
  } catch (error) {
    if (error instanceof MultiEmailError) throw error;
    throw new MultiEmailError(
      "Unable to verify the existing account health. Authorization did not start.",
      "AUTH_PREFLIGHT_FAILED",
    );
  }

  output("Authorization preflight");
  output(`Alias: ${account.alias}`);
  output(`Expected email: ${account.email}`);
  output(`Provider: ${account.provider}`);
  output(`Browser: ${browser}`);
  output(`Scopes: ${authorizationScopes(account.provider).join(" ")}`);
  output(`Existing health: ${safeCell(diagnostic?.status || "unknown")}`);

  if (diagnosticIsHealthy(diagnostic) && !values.force) {
    output(
      `Skipped '${account.alias}': the credential, token, scopes, and identity are already healthy. Use --force to authorize it again.`,
    );
    return;
  }
  if (diagnosticIsHealthy(diagnostic) && values.force) {
    output(`Force: reauthorizing the already healthy alias '${account.alias}'.`);
  }
  if (
    !diagnosticIsHealthy(diagnostic) &&
    !AUTHORIZABLE_HEALTH_STATUSES.has(diagnostic?.status)
  ) {
    throw new MultiEmailError(
      `Authorization did not start because the existing health status is '${safeCell(diagnostic?.status || "unknown")}'. Resolve that condition and run doctor again; --force does not bypass runtime, provider, policy, or configuration failures.`,
      "AUTH_PREFLIGHT_BLOCKED",
    );
  }

  const result = await provider.authorize(account, { browser, onInstruction: output });
  output(`Authorized and verified '${result.alias}' as ${result.email} with ${result.provider}.`);
}

function humanBoolean(value) {
  return value === true ? "yes" : value === false ? "no" : "-";
}

function renderDoctorRecords(records, { json, output }) {
  if (json) {
    for (const record of records) output(JSON.stringify(record));
    return;
  }

  output(
    "ALIAS\tEXPECTED EMAIL\tVERIFIED EMAIL\tPROVIDER\tSTATUS\tCREDENTIAL\tTOKEN\tIDENTITY\tSCOPES\tNEXT STEP",
  );
  for (const record of records) {
    output(
      [
        safeCell(record.alias),
        safeCell(record.expected_email),
        safeCell(record.verified_email),
        safeCell(record.provider),
        safeCell(record.status),
        humanBoolean(record.credential_present),
        humanBoolean(record.token_valid),
        humanBoolean(record.identity_verified),
        humanBoolean(record.scopes_valid),
        safeCell(record.next_step),
      ].join("\t"),
    );
  }
}

async function doctorCommand({
  values,
  positionals,
  configPath,
  output,
  credentialStore,
  providerFactory,
}) {
  if (positionals.length > 1) {
    fail("doctor accepts at most one account alias.");
  }
  const state = await inspectConfiguration(configPath);
  if (state.status === "missing") {
    renderDoctorRecords(
      [doctorSummaryRecord("not_configured", executableCommand("multi-email setup"))],
      { json: values.json, output },
    );
    return;
  }
  if (state.status === "microsoft_repair_required") {
    renderDoctorRecords(
      [
        doctorSummaryRecord(
          "microsoft_repair_required",
          providerSetupCommand("microsoft"),
        ),
      ],
      { json: values.json, output },
    );
    return;
  }

  const config = state.config;
  const accounts = positionals.length ? [findAccount(config, positionals[0])] : config.accounts;
  if (accounts.length === 0) {
    renderDoctorRecords(
      [doctorSummaryRecord("no_accounts", setupNextCommands(state)[0])],
      { json: values.json, output },
    );
    return;
  }

  const records = [];
  for (const account of accounts) {
    if (!providerReady(config, account.provider)) {
      records.push(
        diagnosticRecord(account, {
          status: "configuration_error",
          error_code:
            account.provider === "google"
              ? "GOOGLE_CLIENT_NOT_CONFIGURED"
              : "MICROSOFT_CLIENT_NOT_CONFIGURED",
        }),
      );
      continue;
    }

    try {
      const provider = await providerFactory(account.provider, config, credentialStore);
      records.push(diagnosticRecord(account, await provider.diagnose(account)));
    } catch (error) {
      records.push(unexpectedDiagnosticRecord(account, error));
    }
  }
  renderDoctorRecords(records, { json: values.json, output });
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
      browser: { type: "string" },
      confirm: { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      version: { type: "boolean", short: "V" },
    },
  });
}

export async function run(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console.log;
  const env = dependencies.env || process.env;
  const configPath = dependencies.configPath || defaultConfigPath(env);
  const configLocation = dependencies.configPath || env.CODEX_MULTI_EMAIL_CONFIG
    ? "custom"
    : "default";
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

  assertCommandOptions(command, parsed.values);

  const context = {
    values: parsed.values,
    positionals,
    configPath,
    configLocation,
    output,
    credentialStore,
    providerFactory,
  };
  switch (command) {
    case "setup":
      return setupCommand(context);
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
