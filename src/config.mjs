import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_VERSION, DEFAULT_SAFETY } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL_PATTERN = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;
const PROVIDERS = new Set(["google", "microsoft"]);
const LEGACY_CONFIG_VERSION = 1;

export function defaultConfigPath(env = process.env) {
  if (env.CODEX_MULTI_EMAIL_CONFIG) {
    return path.resolve(env.CODEX_MULTI_EMAIL_CONFIG);
  }

  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "codex-multi-email", "config.json");
}

export function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    profileId: randomUUID(),
    safety: { ...DEFAULT_SAFETY },
    providers: {
      google: {},
      microsoft: { tenant: "organizations" },
    },
    accounts: [],
  };
}

function legacyProfileId(configPath) {
  const digest = createHash("sha256")
    .update(`lanfuli/multi-email\0${path.resolve(configPath)}`)
    .digest("hex")
    .slice(0, 24);
  return `legacy-${digest}`;
}

function upgradeLegacyConfig(input, configPath) {
  if (input?.version !== LEGACY_CONFIG_VERSION) return input;
  return {
    ...input,
    version: CONFIG_VERSION,
    profileId: legacyProfileId(configPath),
  };
}

function assertPositiveInteger(value, key) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MultiEmailError(`${key} must be a positive integer.`, "INVALID_CONFIG");
  }
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MultiEmailError("Config must be a JSON object.", "INVALID_CONFIG");
  }

  if (input.version !== CONFIG_VERSION) {
    throw new MultiEmailError(
      `Unsupported config version: ${String(input.version)}.`,
      "INVALID_CONFIG",
    );
  }

  const profileId = String(input.profileId || "").toLowerCase();
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new MultiEmailError(
      "profileId must be a stable 8-64 character lowercase identifier.",
      "INVALID_CONFIG",
    );
  }

  const safety = { ...DEFAULT_SAFETY, ...(input.safety || {}) };
  assertPositiveInteger(safety.maxSearchResults, "safety.maxSearchResults");
  assertPositiveInteger(safety.maxWriteBatch, "safety.maxWriteBatch");
  assertPositiveInteger(safety.maxRecipients, "safety.maxRecipients");
  assertPositiveInteger(safety.sendApprovalTtlSeconds, "safety.sendApprovalTtlSeconds");

  const providers = {
    google: { ...(input.providers?.google || {}) },
    microsoft: {
      tenant: "organizations",
      ...(input.providers?.microsoft || {}),
    },
  };

  if (providers.microsoft.tenant && typeof providers.microsoft.tenant !== "string") {
    throw new MultiEmailError("providers.microsoft.tenant must be a string.", "INVALID_CONFIG");
  }

  if (!Array.isArray(input.accounts)) {
    throw new MultiEmailError("accounts must be an array.", "INVALID_CONFIG");
  }

  const aliases = new Set();
  const identities = new Set();
  const accounts = input.accounts.map((account, index) => {
    if (!account || typeof account !== "object") {
      throw new MultiEmailError(`accounts[${index}] must be an object.`, "INVALID_CONFIG");
    }

    const alias = String(account.alias || "").toLowerCase();
    const email = String(account.email || "").trim().toLowerCase();
    const provider = String(account.provider || "").toLowerCase();

    if (!ALIAS_PATTERN.test(alias)) {
      throw new MultiEmailError(
        `Invalid account alias '${alias}'. Use 1-32 lowercase letters, digits, '_' or '-'.`,
        "INVALID_CONFIG",
      );
    }
    if (!EMAIL_PATTERN.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
      throw new MultiEmailError(`Invalid account email '${email}'.`, "INVALID_CONFIG");
    }
    if (!PROVIDERS.has(provider)) {
      throw new MultiEmailError(`Unsupported provider '${provider}'.`, "INVALID_CONFIG");
    }
    if (aliases.has(alias)) {
      throw new MultiEmailError(`Duplicate account alias '${alias}'.`, "INVALID_CONFIG");
    }

    const identityKey = `${provider}:${email}`;
    if (identities.has(identityKey)) {
      throw new MultiEmailError(`Duplicate account '${email}'.`, "INVALID_CONFIG");
    }

    aliases.add(alias);
    identities.add(identityKey);
    return { alias, email, provider };
  });

  return { version: CONFIG_VERSION, profileId, safety, providers, accounts };
}

export async function loadConfig(configPath = defaultConfigPath()) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new MultiEmailError(
        `Multi Email is not configured. Run 'npm run setup -- init' in the plugin folder.`,
        "NOT_CONFIGURED",
      );
    }
    throw error;
  }

  try {
    return validateConfig(upgradeLegacyConfig(JSON.parse(raw), configPath));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new MultiEmailError(`Invalid JSON in ${configPath}.`, "INVALID_CONFIG");
    }
    throw error;
  }
}

export async function saveConfig(config, configPath = defaultConfigPath()) {
  const validated = validateConfig(config);
  const parent = path.dirname(configPath);
  const tempPath = `${configPath}.${process.pid}.tmp`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, configPath);
  await chmod(configPath, 0o600);
  return validated;
}

export function findAccount(config, alias) {
  const normalized = String(alias || "").toLowerCase();
  const account = config.accounts.find((candidate) => candidate.alias === normalized);
  if (!account) {
    throw new MultiEmailError(
      `Unknown account alias '${normalized}'. Call mail_list_accounts first.`,
      "UNKNOWN_ACCOUNT",
    );
  }
  return account;
}
