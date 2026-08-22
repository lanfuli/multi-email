import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyConfig, saveConfig } from "../src/config.mjs";
import { MemoryCredentialStore } from "../src/keychain.mjs";
import { run } from "../src/setup.mjs";

test("setup initializes clients, adds accounts, and lists without printing credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-setup-test-"));
  const clientPath = path.join(directory, "desktop-client.json");
  const configPath = path.join(directory, "config.json");
  const output = [];
  const googleSecret = "google-secret-must-not-be-printed";
  const microsoftClientId = "11111111-2222-3333-4444-555555555555";

  try {
    await writeFile(
      clientPath,
      JSON.stringify({
        installed: {
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: googleSecret,
        },
      }),
    );

    await run(
      [
        "init",
        "--google-client-json",
        clientPath,
        "--microsoft-client-id",
        microsoftClientId,
      ],
      { configPath, output: (line) => output.push(line) },
    );
    await run(["add-account", "personal", "Person@Example.com", "google"], {
      configPath,
      output: (line) => output.push(line),
    });
    await run(["list"], { configPath, output: (line) => output.push(line) });

    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(stored.providers.google.clientSecret, googleSecret);
    assert.equal(stored.providers.microsoft.clientId, microsoftClientId);
    assert.deepEqual(stored.accounts, [
      { alias: "personal", email: "person@example.com", provider: "google" },
    ]);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const rendered = output.join("\n");
    assert.match(rendered, /personal\tgoogle\tperson@example\.com/);
    assert.doesNotMatch(rendered, new RegExp(googleSecret));
    assert.doesNotMatch(rendered, new RegExp(microsoftClientId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup refuses a Web-app Google OAuth client file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-setup-test-"));
  const clientPath = path.join(directory, "web-client.json");
  try {
    await writeFile(
      clientPath,
      JSON.stringify({ web: { client_id: "wrong-type", client_secret: "not-used" } }),
    );
    await assert.rejects(
      run(["init", "--google-client-json", clientPath], {
        configPath: path.join(directory, "config.json"),
        output: () => {},
      }),
      { code: "INVALID_GOOGLE_CLIENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor is read-only and renders explicit safe diagnostic fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-doctor-test-"));
  const configPath = path.join(directory, "config.json");
  const config = emptyConfig();
  config.providers.google = {
    clientId: "test.apps.googleusercontent.com",
    clientSecret: "secret-not-for-output",
  };
  config.accounts = [{ alias: "personal", email: "person@example.com", provider: "google" }];
  const credentialStore = new MemoryCredentialStore({ sentinel: "unchanged" });
  const output = [];
  let diagnosticCalls = 0;

  try {
    await saveConfig(config, configPath);
    await run(["doctor", "personal"], {
      configPath,
      credentialStore,
      output: (line) => output.push(line),
      providerFactory: async () => ({
        async diagnose(account) {
          diagnosticCalls += 1;
          return {
            alias: account.alias,
            provider: account.provider,
            credential_present: true,
            token_valid: true,
            identity_verified: true,
            scopes_valid: true,
            status: "ok",
          };
        },
      }),
    });

    assert.equal(diagnosticCalls, 1);
    assert.equal(await credentialStore.get("sentinel"), "unchanged");
    assert.deepEqual(JSON.parse(output[0]), {
      alias: "personal",
      provider: "google",
      credential_present: true,
      token_valid: true,
      identity_verified: true,
      scopes_valid: true,
      status: "ok",
    });
    assert.doesNotMatch(output.join("\n"), /secret-not-for-output/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout and revoke require explicit confirmation before provider state changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-command-test-"));
  const configPath = path.join(directory, "config.json");
  const config = emptyConfig();
  config.providers.google = {
    clientId: "test.apps.googleusercontent.com",
    clientSecret: "test-secret",
  };
  config.accounts = [{ alias: "personal", email: "person@example.com", provider: "google" }];
  const calls = [];
  const dependencies = {
    configPath,
    credentialStore: new MemoryCredentialStore(),
    output: () => {},
    providerFactory: async () => ({
      async logout(account) {
        calls.push(`logout:${account.alias}`);
        return { local_credential_removed: true };
      },
      async revoke(account) {
        calls.push(`revoke:${account.alias}`);
        return { provider_grant_revoked: true };
      },
    }),
  };

  try {
    await saveConfig(config, configPath);
    await assert.rejects(run(["logout", "personal"], dependencies), {
      code: "CONFIRMATION_REQUIRED",
    });
    await assert.rejects(run(["revoke", "personal"], dependencies), {
      code: "CONFIRMATION_REQUIRED",
    });
    assert.deepEqual(calls, []);

    await run(["logout", "personal", "--confirm"], dependencies);
    await run(["revoke", "personal", "--confirm"], dependencies);
    assert.deepEqual(calls, ["logout:personal", "revoke:personal"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
