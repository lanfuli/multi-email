import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialAccountKey,
  KeychainStore,
  MemoryCredentialStore,
} from "../src/keychain.mjs";

test("MemoryCredentialStore implements isolated credential CRUD", async () => {
  const store = new MemoryCredentialStore({ existing: "secret-a" });

  assert.equal(await store.has("existing"), true);
  assert.equal(await store.get("existing"), "secret-a");
  assert.equal(await store.get("missing"), null);

  await store.set("new", "secret-b");
  assert.equal(await store.has("new"), true);
  assert.equal(await store.get("new"), "secret-b");

  assert.equal(await store.delete("new"), true);
  assert.equal(await store.delete("new"), false);
  assert.equal(await store.has("new"), false);
});

test("credential keys isolate profiles and bind the configured mailbox identity", () => {
  const account = { alias: "work", email: "owner@example.com", provider: "google" };
  const first = credentialAccountKey({ profileId: "profile-one" }, account);
  const second = credentialAccountKey({ profileId: "profile-two" }, account);
  const rebound = credentialAccountKey(
    { profileId: "profile-one" },
    { ...account, email: "different@example.com" },
  );

  assert.notEqual(first, second);
  assert.notEqual(first, rebound);
  assert.match(first, /^v2:profile-one:google:work:[A-Za-z0-9_-]{22}$/);
});

test("KeychainStore uses the publisher service and reads legacy entries only explicitly", async () => {
  const values = new Map([
    ["com.openai.codex.multi-email\0google:work", "legacy-secret"],
  ]);
  class FakeEntry {
    constructor(service, account) {
      this.key = `${service}\0${account}`;
    }
    getPassword() {
      return values.get(this.key) || null;
    }
    setPassword(value) {
      values.set(this.key, value);
    }
    deletePassword() {
      return values.delete(this.key);
    }
  }

  const store = new KeychainStore({ EntryClass: FakeEntry });
  const accountKey = credentialAccountKey(
    { profileId: "profile-one" },
    { alias: "work", email: "owner@example.com", provider: "google" },
  );
  await store.set(accountKey, "new-secret");

  assert.equal(
    values.get(`io.github.lanfuli.multi-email\0${accountKey}`),
    "new-secret",
  );
  assert.equal(await store.getLegacy("google:work"), "legacy-secret");
  assert.equal(await store.get("google:work"), null);
});
