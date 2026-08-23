import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyConfig, findAccount, loadConfig, saveConfig, validateConfig } from "../src/config.mjs";

test("validateConfig normalizes account identity and supplies safety defaults", () => {
  const config = emptyConfig();
  config.accounts.push({ alias: "Primary_Gmail", email: " Owner@Example.COM ", provider: "GOOGLE" });

  const result = validateConfig(config);

  assert.deepEqual(result.accounts, [
    { alias: "primary_gmail", email: "owner@example.com", provider: "google" },
  ]);
  assert.equal(result.safety.maxRecipients > 0, true);
  assert.match(result.profileId, /^[a-z0-9-]{8,64}$/);
  assert.equal(findAccount(result, "PRIMARY_GMAIL").email, "owner@example.com");
});

test("validateConfig canonicalizes Microsoft OAuth configuration", () => {
  const config = emptyConfig();
  config.providers.microsoft = {
    clientId: " ABCDEFAB-1234-5678-90AB-ABCDEFABCDEF ",
    tenant: " Example.OnMicrosoft.COM ",
  };

  const result = validateConfig(config);

  assert.deepEqual(result.providers.microsoft, {
    clientId: "abcdefab-1234-5678-90ab-abcdefabcdef",
    tenant: "example.onmicrosoft.com",
  });

  for (const microsoft of [
    { clientId: "not-a-guid", tenant: "organizations" },
    { clientId: "abcdefab-1234-5678-90ab-abcdefabcdef", tenant: "../common" },
  ]) {
    const invalid = emptyConfig();
    invalid.providers.microsoft = microsoft;
    assert.throws(() => validateConfig(invalid), { code: "INVALID_CONFIG" });
  }
});

test("legacy version-one config gets a stable path-bound profile without an implicit write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-config-test-"));
  const configPath = path.join(directory, "config.json");
  const legacy = {
    version: 1,
    safety: emptyConfig().safety,
    providers: { google: {}, microsoft: { tenant: "organizations" } },
    accounts: [],
  };

  try {
    await writeFile(configPath, `${JSON.stringify(legacy)}\n`);
    const first = await loadConfig(configPath);
    const second = await loadConfig(configPath);

    assert.equal(first.version, 2);
    assert.equal(first.profileId, second.profileId);
    assert.match(first.profileId, /^legacy-[a-f0-9]{24}$/);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).version, 1);

    await saveConfig(first, configPath);
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.version, 2);
    assert.equal(persisted.profileId, first.profileId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validateConfig rejects duplicate aliases after normalization", () => {
  const config = emptyConfig();
  config.accounts = [
    { alias: "work", email: "one@example.com", provider: "google" },
    { alias: "WORK", email: "two@example.com", provider: "microsoft" },
  ];

  assert.throws(
    () => validateConfig(config),
    (error) => error.code === "INVALID_CONFIG" && /Duplicate account alias 'work'/.test(error.message),
  );
});

test("validateConfig rejects the same provider identity under another alias", () => {
  const config = emptyConfig();
  config.accounts = [
    { alias: "first", email: "owner@example.com", provider: "google" },
    { alias: "second", email: "OWNER@example.com", provider: "google" },
  ];

  assert.throws(
    () => validateConfig(config),
    (error) => error.code === "INVALID_CONFIG" && /Duplicate account 'owner@example.com'/.test(error.message),
  );
});

test("validateConfig rejects unsupported providers and invalid safety values", () => {
  const unsupported = emptyConfig();
  unsupported.accounts = [{ alias: "mail", email: "owner@example.com", provider: "imap" }];
  assert.throws(() => validateConfig(unsupported), { code: "INVALID_CONFIG" });

  const unsafe = emptyConfig();
  unsafe.safety.maxWriteBatch = 0;
  assert.throws(() => validateConfig(unsafe), { code: "INVALID_CONFIG" });

  const controlCharacter = emptyConfig();
  controlCharacter.accounts = [
    { alias: "mail", email: "owner\0@example.com", provider: "google" },
  ];
  assert.throws(() => validateConfig(controlCharacter), { code: "INVALID_CONFIG" });

  const htmlBearing = emptyConfig();
  htmlBearing.accounts = [
    { alias: "mail", email: "<script>@example.com", provider: "google" },
  ];
  assert.throws(() => validateConfig(htmlBearing), { code: "INVALID_CONFIG" });

  const groupSyntax = emptyConfig();
  groupSyntax.accounts = [
    { alias: "mail", email: "victim:attacker@example.com", provider: "google" },
  ];
  assert.throws(() => validateConfig(groupSyntax), { code: "INVALID_CONFIG" });
});

test("loadConfig does not disclose its filesystem path for invalid JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-config-json-"));
  const configPath = path.join(directory, "private-name.json");
  try {
    await writeFile(configPath, "{not-json\n");
    await assert.rejects(
      loadConfig(configPath),
      (error) =>
        error.code === "INVALID_CONFIG" &&
        !error.message.includes(configPath) &&
        !error.message.includes("private-name.json"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saveConfig preserves existing parent permissions and secures new files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-config-mode-"));
  const existingParent = path.join(directory, "shared");
  const newParent = path.join(directory, "private");
  try {
    await mkdir(existingParent, { mode: 0o755 });
    await chmod(existingParent, 0o755);

    const existingPath = path.join(existingParent, "config.json");
    const newPath = path.join(newParent, "config.json");
    await saveConfig(emptyConfig(), existingPath);
    await saveConfig(emptyConfig(), newPath);

    assert.equal((await lstat(existingParent)).mode & 0o777, 0o755);
    assert.equal((await lstat(newParent)).mode & 0o777, 0o700);
    assert.equal((await lstat(existingPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(newPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saveConfig rejects symlink and non-regular targets without touching their contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-config-link-"));
  const victimPath = path.join(directory, "victim.txt");
  const linkedPath = path.join(directory, "config.json");
  const directoryPath = path.join(directory, "config-directory");
  try {
    await writeFile(victimPath, "keep me\n", { mode: 0o644 });
    await symlink(victimPath, linkedPath);
    await mkdir(directoryPath);

    await assert.rejects(saveConfig(emptyConfig(), linkedPath), {
      code: "INVALID_CONFIG_PATH",
    });
    await assert.rejects(saveConfig(emptyConfig(), directoryPath), {
      code: "INVALID_CONFIG_PATH",
    });
    assert.equal(await readFile(victimPath, "utf8"), "keep me\n");
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saveConfig ignores the old predictable temporary path and never follows it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-config-temp-link-"));
  const victimPath = path.join(directory, "victim.txt");
  const configPath = path.join(directory, "config.json");
  const predictableTempPath = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(victimPath, "do not overwrite\n", { mode: 0o644 });
    await symlink(victimPath, predictableTempPath);

    await saveConfig(emptyConfig(), configPath);

    assert.equal(await readFile(victimPath, "utf8"), "do not overwrite\n");
    assert.equal((await lstat(predictableTempPath)).isSymbolicLink(), true);
    assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured safety values may tighten but never expand hard limits", () => {
  const tighter = emptyConfig();
  tighter.safety = {
    maxSearchResults: 5,
    maxWriteBatch: 4,
    maxRecipients: 3,
    sendApprovalTtlSeconds: 60,
  };
  assert.deepEqual(validateConfig(tighter).safety, tighter.safety);

  for (const [key, value] of [
    ["maxSearchResults", 26],
    ["maxWriteBatch", 26],
    ["maxRecipients", 21],
    ["sendApprovalTtlSeconds", 301],
  ]) {
    const expanded = emptyConfig();
    expanded.safety[key] = value;
    assert.throws(
      () => validateConfig(expanded),
      (error) =>
        error.code === "INVALID_CONFIG" &&
        error.message.includes(`safety.${key} cannot exceed the hard safety limit`),
    );
  }
});
