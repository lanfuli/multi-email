import { MultiEmailError } from "./errors.mjs";

function rollbackFailed() {
  return new MultiEmailError(
    "The OAuth credential update failed and the previous macOS Keychain state could not be restored or verified. Stop and inspect the account before retrying.",
    "CREDENTIAL_ROLLBACK_FAILED",
  );
}

export async function replaceCredentialVerified(credentialStore, key, nextValue) {
  // Read before mutation so a failed authorization cannot destroy a credential
  // already stored for this exact profile/account key.
  const previousValue = await credentialStore.get(key);

  try {
    await credentialStore.set(key, nextValue);
    if ((await credentialStore.get(key)) !== nextValue) {
      throw new MultiEmailError(
        "The OAuth credential update could not be verified in macOS Keychain.",
        "KEYCHAIN_WRITE_FAILED",
      );
    }
  } catch {
    try {
      if (previousValue === null) {
        await credentialStore.delete(key);
      } else {
        await credentialStore.set(key, previousValue);
      }
      if ((await credentialStore.get(key)) !== previousValue) throw rollbackFailed();
    } catch {
      throw rollbackFailed();
    }

    throw new MultiEmailError(
      previousValue === null
        ? "The OAuth credential update failed. No new credential was retained."
        : "The OAuth credential update failed. The previous credential was restored.",
      "KEYCHAIN_WRITE_FAILED",
    );
  }
}
