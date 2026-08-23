import assert from "node:assert/strict";
import test from "node:test";
import { replaceCredentialVerified } from "../src/credential-transaction.mjs";
import { MemoryCredentialStore } from "../src/keychain.mjs";

test("credential replacement removes an unverifiable new value when no old value existed", async () => {
  const store = new MemoryCredentialStore();
  const memoryGet = store.get.bind(store);
  let corruptReadback = false;
  store.set = async (key, value) => {
    store.values.set(key, value);
    corruptReadback = true;
  };
  store.get = async (key) => {
    if (corruptReadback) {
      corruptReadback = false;
      return "unverified-value";
    }
    return memoryGet(key);
  };

  await assert.rejects(
    replaceCredentialVerified(store, "account-key", "new-credential"),
    { code: "KEYCHAIN_WRITE_FAILED" },
  );
  assert.equal(await store.get("account-key"), null);
});

test("credential replacement deletes a new value when its Keychain readback throws", async () => {
  const store = new MemoryCredentialStore();
  const memoryGet = store.get.bind(store);
  const memoryDelete = store.delete.bind(store);
  let getCalls = 0;
  let deleteCalls = 0;
  store.get = async (key) => {
    getCalls += 1;
    if (getCalls === 2) throw new Error("simulated readback failure");
    return memoryGet(key);
  };
  store.delete = async (key) => {
    deleteCalls += 1;
    return memoryDelete(key);
  };

  await assert.rejects(
    replaceCredentialVerified(store, "account-key", "new-credential"),
    { code: "KEYCHAIN_WRITE_FAILED" },
  );
  assert.equal(deleteCalls, 1);
  assert.equal(await store.get("account-key"), null);
});

function assertSafeRollbackFailure(error) {
  assert.equal(error.code, "CREDENTIAL_ROLLBACK_FAILED");
  assert.doesNotMatch(
    `${error.message} ${JSON.stringify(error.details)}`,
    /previous-secret|replacement-secret|provider-controlled/iu,
  );
  assert.doesNotMatch(error.message, /(?:was|is) (?:preserved|restored|retained)/iu);
  return true;
}

test("credential replacement reports an explicit safe error when rollback cannot complete", async () => {
  const previousCredential = "previous-secret-must-not-leak";
  const replacementCredential = "replacement-secret-must-not-leak";
  const store = new MemoryCredentialStore({ "account-key": previousCredential });
  const memoryGet = store.get.bind(store);
  const memorySet = store.set.bind(store);
  let replacementWritten = false;
  store.set = async (key, value) => {
    if (replacementWritten && value === previousCredential) {
      throw new Error("simulated rollback failure with provider-controlled text");
    }
    await memorySet(key, value);
    if (value === replacementCredential) replacementWritten = true;
  };
  store.get = async (key) => {
    if (replacementWritten) throw new Error("simulated verification failure");
    return memoryGet(key);
  };

  await assert.rejects(
    replaceCredentialVerified(store, "account-key", replacementCredential),
    assertSafeRollbackFailure,
  );
});

test("credential replacement reports rollback failure when deletion fails", async () => {
  const store = new MemoryCredentialStore();
  const memoryGet = store.get.bind(store);
  let readback = false;
  store.set = async (key, value) => {
    store.values.set(key, value);
    readback = true;
  };
  store.get = async (key) => {
    if (readback) {
      readback = false;
      return "provider-controlled-unverified-value";
    }
    return memoryGet(key);
  };
  store.delete = async () => {
    throw new Error("provider-controlled delete failure");
  };

  await assert.rejects(
    replaceCredentialVerified(store, "account-key", "replacement-secret-must-not-leak"),
    assertSafeRollbackFailure,
  );
});

test("credential replacement reports rollback failure when restoration cannot be verified", async () => {
  const previousCredential = "previous-secret-must-not-leak";
  const replacementCredential = "replacement-secret-must-not-leak";
  const store = new MemoryCredentialStore({ "account-key": previousCredential });
  const memorySet = store.set.bind(store);
  let getCalls = 0;
  store.set = async (key, value) => memorySet(key, value);
  store.get = async () => {
    getCalls += 1;
    if (getCalls === 1) return previousCredential;
    return "provider-controlled-unverified-value";
  };

  await assert.rejects(
    replaceCredentialVerified(store, "account-key", replacementCredential),
    assertSafeRollbackFailure,
  );
});
