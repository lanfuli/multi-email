import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
