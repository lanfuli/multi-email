import { createHash } from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import { KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE } from "./constants.mjs";
import { MultiEmailError } from "./errors.mjs";

export function credentialAccountKey(config, account, suffix = "") {
  const profileId = String(config?.profileId || "");
  const provider = String(account?.provider || "").toLowerCase();
  const alias = String(account?.alias || "").toLowerCase();
  const email = String(account?.email || "").trim().toLowerCase();
  if (!profileId || !provider || !alias || !email) {
    throw new MultiEmailError(
      "Cannot address a credential without a profile and account identity.",
      "INVALID_CONFIG",
    );
  }
  const identityDigest = createHash("sha256").update(email).digest("base64url").slice(0, 22);
  return `v2:${profileId}:${provider}:${alias}:${identityDigest}${suffix}`;
}

export function legacyCredentialAccountKey(account, suffix = "") {
  return `${String(account?.provider || "").toLowerCase()}:${String(account?.alias || "").toLowerCase()}${suffix}`;
}

export class KeychainStore {
  constructor({
    service = KEYCHAIN_SERVICE,
    legacyService = LEGACY_KEYCHAIN_SERVICE,
    EntryClass = Entry,
  } = {}) {
    this.service = service;
    this.legacyService = legacyService;
    this.EntryClass = EntryClass;
  }

  entry(accountKey, service = this.service) {
    return new this.EntryClass(service, accountKey);
  }

  async has(accountKey) {
    return (await this.get(accountKey)) !== null;
  }

  async get(accountKey) {
    try {
      return this.entry(accountKey).getPassword() || null;
    } catch (error) {
      if (/not found|no entry|item.*exist/i.test(error?.message || "")) {
        return null;
      }
      throw new MultiEmailError(
        "Unable to read the OAuth credential from macOS Keychain.",
        "KEYCHAIN_READ_FAILED",
      );
    }
  }

  async set(accountKey, secret) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new MultiEmailError("Refusing to store an empty credential.", "KEYCHAIN_WRITE_FAILED");
    }

    try {
      this.entry(accountKey).setPassword(secret);
    } catch {
      throw new MultiEmailError(
        "Unable to store the OAuth credential in macOS Keychain.",
        "KEYCHAIN_WRITE_FAILED",
      );
    }
  }

  async delete(accountKey) {
    try {
      return this.entry(accountKey).deletePassword();
    } catch (error) {
      if (/not found|no entry|item.*exist/i.test(error?.message || "")) {
        return false;
      }
      throw new MultiEmailError(
        "Unable to delete the OAuth credential from macOS Keychain.",
        "KEYCHAIN_DELETE_FAILED",
      );
    }
  }

  async getLegacy(accountKey) {
    try {
      return this.entry(accountKey, this.legacyService).getPassword() || null;
    } catch (error) {
      if (/not found|no entry|item.*exist/i.test(error?.message || "")) {
        return null;
      }
      throw new MultiEmailError(
        "Unable to read a legacy OAuth credential from macOS Keychain.",
        "KEYCHAIN_READ_FAILED",
      );
    }
  }

  async deleteLegacy(accountKey) {
    try {
      return this.entry(accountKey, this.legacyService).deletePassword();
    } catch (error) {
      if (/not found|no entry|item.*exist/i.test(error?.message || "")) {
        return false;
      }
      throw new MultiEmailError(
        "Unable to delete a legacy OAuth credential from macOS Keychain.",
        "KEYCHAIN_DELETE_FAILED",
      );
    }
  }
}

export class MemoryCredentialStore {
  constructor(seed = {}, { legacy = {} } = {}) {
    this.values = new Map(Object.entries(seed));
    this.legacyValues = new Map(Object.entries(legacy));
  }

  async has(key) {
    return this.values.has(key);
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    return this.values.delete(key);
  }

  async getLegacy(key) {
    return this.legacyValues.get(key) ?? null;
  }

  async deleteLegacy(key) {
    return this.legacyValues.delete(key);
  }
}
