import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_VERSION, DEFAULT_SAFETY, HARD_SAFETY_LIMITS } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";
import {
  normalizeMailboxAddress,
  normalizeMicrosoftClientId,
  normalizeMicrosoftTenant,
} from "./validation.mjs";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
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

function assertAtMost(value, key, maximum) {
  if (value > maximum) {
    throw new MultiEmailError(
      `${key} cannot exceed the hard safety limit of ${maximum}.`,
      "INVALID_CONFIG",
    );
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
  assertAtMost(
    safety.maxSearchResults,
    "safety.maxSearchResults",
    HARD_SAFETY_LIMITS.maxSearchResults,
  );
  assertAtMost(
    safety.maxWriteBatch,
    "safety.maxWriteBatch",
    HARD_SAFETY_LIMITS.maxWriteBatch,
  );
  assertAtMost(
    safety.maxRecipients,
    "safety.maxRecipients",
    HARD_SAFETY_LIMITS.maxRecipients,
  );
  assertAtMost(
    safety.sendApprovalTtlSeconds,
    "safety.sendApprovalTtlSeconds",
    HARD_SAFETY_LIMITS.sendApprovalTtlSeconds,
  );

  const providers = {
    google: { ...(input.providers?.google || {}) },
    microsoft: {
      tenant: "organizations",
      ...(input.providers?.microsoft || {}),
    },
  };

  providers.microsoft.tenant = normalizeMicrosoftTenant(
    providers.microsoft.tenant,
    { code: "INVALID_CONFIG" },
  );
  if (Object.hasOwn(providers.microsoft, "clientId")) {
    providers.microsoft.clientId = normalizeMicrosoftClientId(
      providers.microsoft.clientId,
      { code: "INVALID_CONFIG" },
    );
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
    const email = normalizeMailboxAddress(account.email, {
      field: `accounts[${index}].email`,
      code: "INVALID_CONFIG",
    });
    const provider = String(account.provider || "").toLowerCase();

    if (!ALIAS_PATTERN.test(alias)) {
      throw new MultiEmailError(
        `Invalid account alias '${alias}'. Use 1-32 lowercase letters, digits, '_' or '-'.`,
        "INVALID_CONFIG",
      );
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

async function readConfigDocument(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new MultiEmailError(
        "Multi Email is not configured. Run 'multi-email init ...' (or 'node ./scripts/multi-email init ...' from a Git clone).",
        "NOT_CONFIGURED",
      );
    }
    throw error;
  }

  try {
    return upgradeLegacyConfig(JSON.parse(raw), configPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new MultiEmailError("The Multi Email config contains invalid JSON.", "INVALID_CONFIG");
    }
    throw error;
  }
}

export async function loadConfig(configPath = defaultConfigPath()) {
  return validateConfig(await readConfigDocument(configPath));
}

// v0.1.1 accepted malformed Microsoft client IDs and tenant values. Setup may
// use this narrow loader only when it will immediately replace that provider
// block; every other config field is still validated before anything is saved.
export async function loadConfigForMicrosoftRepair(configPath = defaultConfigPath()) {
  const input = await readConfigDocument(configPath);
  const providerInput =
    input?.providers && typeof input.providers === "object" && !Array.isArray(input.providers)
      ? input.providers
      : {};
  let tenant = "organizations";
  try {
    tenant = normalizeMicrosoftTenant(providerInput.microsoft?.tenant || tenant, {
      code: "INVALID_CONFIG",
    });
  } catch {
    // The setup command using this loader immediately replaces the Microsoft
    // block; an invalid legacy tenant safely falls back to organizations.
  }
  return validateConfig({
    ...input,
    providers: {
      ...providerInput,
      microsoft: { tenant },
    },
  });
}

export async function saveConfig(config, configPath = defaultConfigPath()) {
  const validated = validateConfig(config);
  const parent = path.dirname(configPath);
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;

  try {
    const target = await lstat(configPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (target && (!target.isFile() || target.isSymbolicLink())) {
      throw new MultiEmailError(
        "The Multi Email config path must be a regular file, not a link or special file.",
        "INVALID_CONFIG_PATH",
      );
    }

    const created = await mkdir(parent, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(parent, 0o700);

    const flags =
      FS_CONSTANTS.O_WRONLY |
      FS_CONSTANTS.O_CREAT |
      FS_CONSTANTS.O_EXCL |
      (FS_CONSTANTS.O_NOFOLLOW || 0);
    handle = await open(tempPath, flags, 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, configPath);
    return validated;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
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
