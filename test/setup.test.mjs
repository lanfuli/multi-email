import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyConfig, saveConfig } from "../src/config.mjs";
import { APP_VERSION } from "../src/constants.mjs";
import { MultiEmailError } from "../src/errors.mjs";
import { MemoryCredentialStore } from "../src/keychain.mjs";
import { formatSetupError, run, runSetupCli } from "../src/setup.mjs";

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

test("setup supports Microsoft-only init with a strict client GUID and tenant", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-microsoft-test-"));
  const configPath = path.join(directory, "config.json");
  const output = [];
  const clientId = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";

  try {
    await run(
      [
        "init",
        "--microsoft-client-id",
        clientId,
        "--microsoft-tenant",
        "Example.OnMicrosoft.com",
      ],
      { configPath, output: (line) => output.push(line) },
    );

    const stored = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(stored.providers.google, {});
    assert.deepEqual(stored.providers.microsoft, {
      clientId: clientId.toLowerCase(),
      tenant: "example.onmicrosoft.com",
    });
    assert.match(output.join("\n"), /Microsoft OAuth is configured/);
    assert.match(output.join("\n"), /Google can be added later/);

    await assert.rejects(
      run(["set-microsoft-client", "not-a-guid"], { configPath, output: () => {} }),
      { code: "INVALID_ARGUMENT" },
    );
    await assert.rejects(
      run(
        [
          "set-microsoft-client",
          "11111111-2222-3333-4444-555555555555",
          "--microsoft-tenant",
          "invalid/tenant",
        ],
        { configPath, output: () => {} },
      ),
      { code: "INVALID_ARGUMENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("init requires a provider option and reports preserved provider configuration truthfully", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-init-test-"));
  const clientPath = path.join(directory, "desktop-client.json");
  const configPath = path.join(directory, "config.json");
  const output = [];

  try {
    await assert.rejects(run(["init"], { configPath, output: () => {} }), {
      code: "INVALID_ARGUMENT",
    });
    await assert.rejects(
      run(["init", "--microsoft-client-id", "not-a-guid"], {
        configPath,
        output: () => {},
      }),
      { code: "INVALID_ARGUMENT" },
    );

    await run(
      [
        "init",
        "--microsoft-client-id",
        "11111111-2222-3333-4444-555555555555",
      ],
      { configPath, output: () => {} },
    );
    await writeFile(
      clientPath,
      JSON.stringify({
        installed: {
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      }),
    );
    await run(["init", "--google-client-json", clientPath], {
      configPath,
      output: (line) => output.push(line),
    });
    assert.match(output.join("\n"), /Google and Microsoft OAuth clients are configured/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup repairs Microsoft values that v0.1.1 allowed without weakening other config checks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-repair-test-"));
  const setConfigPath = path.join(directory, "set-config.json");
  const initConfigPath = path.join(directory, "init-config.json");
  const validClientId = "11111111-2222-3333-4444-555555555555";

  const legacyInvalid = () => {
    const config = emptyConfig();
    config.providers.google = {
      clientId: "test.apps.googleusercontent.com",
      clientSecret: "preserved-secret",
    };
    config.providers.microsoft = {
      clientId: "not-a-guid",
      tenant: "bad?tenant",
    };
    config.accounts = [
      { alias: "personal", email: "person@example.com", provider: "google" },
    ];
    return config;
  };

  try {
    await writeFile(setConfigPath, `${JSON.stringify(legacyInvalid(), null, 2)}\n`);
    await run(["set-microsoft-client", validClientId], {
      configPath: setConfigPath,
      output: () => {},
    });
    const repairedBySet = JSON.parse(await readFile(setConfigPath, "utf8"));
    assert.deepEqual(repairedBySet.providers.microsoft, {
      clientId: validClientId,
      tenant: "organizations",
    });
    assert.equal(repairedBySet.providers.google.clientSecret, "preserved-secret");
    assert.equal(repairedBySet.accounts[0].alias, "personal");

    await writeFile(initConfigPath, `${JSON.stringify(legacyInvalid(), null, 2)}\n`);
    await run(
      [
        "init",
        "--microsoft-client-id",
        validClientId,
        "--microsoft-tenant",
        "common",
      ],
      { configPath: initConfigPath, output: () => {} },
    );
    const repairedByInit = JSON.parse(await readFile(initConfigPath, "utf8"));
    assert.deepEqual(repairedByInit.providers.microsoft, {
      clientId: validClientId,
      tenant: "common",
    });
    assert.equal(repairedByInit.providers.google.clientSecret, "preserved-secret");
    assert.equal(repairedByInit.accounts[0].alias, "personal");

    const invalidOutsideMicrosoft = legacyInvalid();
    invalidOutsideMicrosoft.accounts[0].email = "not-an-address";
    await writeFile(setConfigPath, `${JSON.stringify(invalidOutsideMicrosoft, null, 2)}\n`);
    await assert.rejects(
      run(["set-microsoft-client", validClientId], {
        configPath: setConfigPath,
        output: () => {},
      }),
      { code: "INVALID_CONFIG" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("add-account rejects providers whose OAuth client is not configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-provider-test-"));
  const configPath = path.join(directory, "config.json");

  try {
    await run(
      [
        "init",
        "--microsoft-client-id",
        "11111111-2222-3333-4444-555555555555",
      ],
      { configPath, output: () => {} },
    );
    await assert.rejects(
      run(["add-account", "personal", "person@example.com", "google"], {
        configPath,
        output: () => {},
      }),
      (error) => {
        assert.equal(error.code, "PROVIDER_NOT_CONFIGURED");
        assert.match(error.message, /multi-email init --google-client-json/);
        return true;
      },
    );
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).accounts, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup version flags and help work for installed and Git-clone entrypoints", async () => {
  for (const flag of ["--version", "-V"]) {
    const output = [];
    await run([flag], { output: (line) => output.push(line) });
    assert.deepEqual(output, [APP_VERSION]);
  }

  const output = [];
  await run(["--help"], { output: (line) => output.push(line) });
  const rendered = output.join("\n");
  assert.match(rendered, /multi-email init/);
  assert.match(rendered, /node \.\/scripts\/multi-email/);
  assert.doesNotMatch(rendered, /npm run setup/);
});

test("safe setup runner redacts unknown errors but preserves MultiEmailError messages", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-redaction-test-"));
  const configPath = path.join(directory, "config.json");
  const config = emptyConfig();
  config.providers.google = {
    clientId: "test.apps.googleusercontent.com",
    clientSecret: "test-secret",
  };
  config.accounts = [{ alias: "personal", email: "person@example.com", provider: "google" }];
  const errors = [];
  const exitCodes = [];
  const secret = "refresh-token-must-never-be-rendered";

  try {
    await saveConfig(config, configPath);
    const succeeded = await runSetupCli(["auth", "personal"], {
      configPath,
      output: () => {},
      errorOutput: (line) => errors.push(line),
      setExitCode: (code) => exitCodes.push(code),
      providerFactory: async () => {
        throw new Error(`provider failed with ${secret}`);
      },
    });

    assert.equal(succeeded, false);
    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(errors, ["Setup failed: an unexpected local or provider error occurred."]);
    assert.doesNotMatch(errors.join("\n"), new RegExp(secret));
    assert.equal(
      formatSetupError(new MultiEmailError("safe setup message", "SAFE_SETUP_ERROR")),
      "Setup failed [SAFE_SETUP_ERROR]: safe setup message",
    );
    assert.equal(
      formatSetupError(new Error("unsafe provider detail")),
      "Setup failed: an unexpected local or provider error occurred.",
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
