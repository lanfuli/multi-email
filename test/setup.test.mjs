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

test("setup preflight is non-interactive and reports a safe next command when config is missing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-preflight-test-"));
  const configPath = path.join(directory, "missing", "config.json");
  const output = [];
  let providerCalls = 0;

  try {
    await run(["setup"], {
      configPath,
      credentialStore: {
        async get() {
          throw new Error("setup must not read credentials");
        },
      },
      output: (line) => output.push(line),
      providerFactory: async () => {
        providerCalls += 1;
        throw new Error("setup must not instantiate providers");
      },
    });

    const rendered = output.join("\n");
    assert.match(rendered, new RegExp(`Version\\tready\\t${APP_VERSION.replaceAll(".", "\\.")}`));
    assert.match(rendered, /Config\tmissing\tcustom/);
    assert.match(rendered, /Google OAuth\tnot_configured\tclient required/);
    assert.match(rendered, /Microsoft OAuth\tnot_configured\tclient required/);
    assert.match(rendered, /Accounts\tnone\t0/);
    assert.match(
      rendered,
      /Next: multi-email init --google-client-json <desktop-oauth\.json>/,
    );
    assert.match(
      rendered,
      /Alternative: multi-email init --microsoft-client-id <application-guid> --microsoft-tenant organizations/,
    );
    assert.match(
      rendered,
      /or node \.\/scripts\/multi-email init --google-client-json <desktop-oauth\.json> from a Git clone/,
    );
    assert.match(
      rendered,
      /or node \.\/scripts\/multi-email init --microsoft-client-id <application-guid> --microsoft-tenant organizations from a Git clone/,
    );
    assert.equal(providerCalls, 0);
    await assert.rejects(stat(configPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup labels default and custom config locations without exposing their paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-preflight-path-test-"));
  const sensitiveMarker = "private-user-name-and-secret-folder";
  const customPath = path.join(directory, sensitiveMarker, "config.json");

  try {
    const defaultOutput = [];
    await run(["setup"], {
      env: { XDG_CONFIG_HOME: path.join(directory, "default-root") },
      output: (line) => defaultOutput.push(line),
    });
    assert.match(defaultOutput.join("\n"), /Config\tmissing\tdefault/);

    const customOutput = [];
    await run(["setup"], {
      env: { CODEX_MULTI_EMAIL_CONFIG: customPath },
      credentialStore: {
        async get() {
          throw new Error("setup must not read credentials");
        },
      },
      output: (line) => customOutput.push(line),
      providerFactory: async () => {
        throw new Error("setup must not instantiate providers");
      },
    });

    const rendered = customOutput.join("\n");
    assert.match(rendered, /Config\tmissing\tcustom/);
    assert.doesNotMatch(rendered, new RegExp(sensitiveMarker));
    assert.doesNotMatch(rendered, new RegExp(directory.replaceAll(".", "\\.")));
    await assert.rejects(stat(customPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup preflight reports provider readiness, account count, and remains read-only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-preflight-ready-test-"));
  const configPath = path.join(directory, "config.json");
  const config = emptyConfig();
  config.providers.google = {
    clientId: "test.apps.googleusercontent.com",
    clientSecret: "preflight-secret-must-not-be-printed",
  };
  config.accounts = [{ alias: "personal", email: "person@example.com", provider: "google" }];
  const output = [];

  try {
    await saveConfig(config, configPath);
    const before = await readFile(configPath, "utf8");
    await run(["setup"], {
      configPath,
      output: (line) => output.push(line),
      providerFactory: async () => {
        throw new Error("setup must not instantiate providers");
      },
    });

    const rendered = output.join("\n");
    assert.match(rendered, /Config\tready\t/);
    assert.match(rendered, /Google OAuth\tready\tclient configured/);
    assert.match(rendered, /Microsoft OAuth\tnot_configured\tclient required/);
    assert.match(rendered, /Accounts\tconfigured\t1/);
    assert.match(rendered, /Next: multi-email doctor/);
    assert.match(
      rendered,
      /or node \.\/scripts\/multi-email doctor from a Git clone/,
    );
    assert.doesNotMatch(rendered, /preflight-secret-must-not-be-printed/);
    assert.equal(await readFile(configPath, "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup and doctor expose the safe repair command for legacy Microsoft config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-preflight-repair-test-"));
  const configPath = path.join(directory, "config.json");
  const config = emptyConfig();
  config.providers.google = {
    clientId: "test.apps.googleusercontent.com",
    clientSecret: "legacy-secret-must-not-be-printed",
  };
  config.providers.microsoft = {
    clientId: "legacy-invalid-client-id",
    tenant: "legacy?invalid-tenant",
  };
  config.accounts = [{ alias: "personal", email: "person@example.com", provider: "google" }];
  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  try {
    await writeFile(configPath, serialized);
    for (const args of [["setup"], ["doctor"], ["doctor", "--json"]]) {
      const output = [];
      await run(args, {
        configPath,
        output: (line) => output.push(line),
        providerFactory: async () => {
          throw new Error("repair preflight must not instantiate providers");
        },
      });
      const rendered = output.join("\n");
      assert.match(rendered, /microsoft_repair_required/);
      assert.match(rendered, /multi-email set-microsoft-client <application-guid>/);
      assert.match(
        rendered,
        /or node \.\/scripts\/multi-email set-microsoft-client <application-guid> from a Git clone/,
      );
      assert.doesNotMatch(rendered, /legacy-secret-must-not-be-printed/);
      assert.doesNotMatch(rendered, /legacy-invalid-client-id/);
      assert.doesNotMatch(rendered, /legacy\?invalid-tenant/);
      assert.equal(await readFile(configPath, "utf8"), serialized);
    }
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
  assert.match(rendered, /multi-email setup/);
  assert.match(rendered, /multi-email init/);
  assert.match(rendered, /multi-email doctor \[alias\] \[--json\]/);
  assert.match(rendered, /node \.\/scripts\/multi-email/);
  assert.doesNotMatch(rendered, /npm run setup/);
});

test("setup and doctor reject extra positionals and command-specific options", async () => {
  await assert.rejects(run(["setup", "unexpected"], { output: () => {} }), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(run(["setup", "--json"], { output: () => {} }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /Option '--json' is not valid for 'setup'/);
    return true;
  });
  await assert.rejects(run(["list", "--json"], { output: () => {} }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /Option '--json' is not valid for 'list'/);
    return true;
  });
  await assert.rejects(run(["doctor", "one", "two"], { output: () => {} }), {
    code: "INVALID_ARGUMENT",
  });
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

test("doctor defaults to a human-readable table with an explicit next step for every status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-doctor-test-"));
  const configPath = path.join(directory, "config.json");
  const config = emptyConfig();
  config.providers.google = {
    clientId: "test.apps.googleusercontent.com",
    clientSecret: "secret-not-for-output",
  };
  const statusByAlias = {
    ready: "ok",
    new: "not_authorized",
    corrupt: "invalid_credential",
    stale: "reauthorization_required",
    scopes: "insufficient_scopes",
    wrong: "identity_mismatch",
    offline: "provider_unavailable",
    client: "configuration_error",
  };
  config.accounts = Object.keys(statusByAlias).map((alias) => ({
    alias,
    email: `${alias}@example.com`,
    provider: "google",
  }));
  const credentialStore = new MemoryCredentialStore({ sentinel: "unchanged" });
  const output = [];
  let diagnosticCalls = 0;

  try {
    await saveConfig(config, configPath);
    await run(["doctor"], {
      configPath,
      credentialStore,
      output: (line) => output.push(line),
      providerFactory: async () => ({
        async diagnose(account) {
          diagnosticCalls += 1;
          return {
            secret: "diagnostic-secret-must-not-be-printed",
            credential_present: true,
            token_valid: account.alias === "ready" ? true : null,
            identity_verified: account.alias === "ready" ? true : null,
            scopes_valid: account.alias === "ready" ? true : null,
            status: statusByAlias[account.alias],
          };
        },
      }),
    });

    assert.equal(diagnosticCalls, Object.keys(statusByAlias).length);
    assert.equal(await credentialStore.get("sentinel"), "unchanged");
    assert.equal(
      output[0],
      "ALIAS\tPROVIDER\tSTATUS\tCREDENTIAL\tTOKEN\tIDENTITY\tSCOPES\tNEXT STEP",
    );
    const rendered = output.join("\n");
    assert.match(rendered, /ready\tgoogle\tok\tyes\tyes\tyes\tyes\tnone \(ready\)/);
    for (const alias of ["new", "corrupt", "stale", "scopes", "wrong"]) {
      assert.match(rendered, new RegExp(`${alias}\\tgoogle\\t${statusByAlias[alias]}.*multi-email auth ${alias}`));
    }
    assert.match(
      rendered,
      /offline\tgoogle\tprovider_unavailable.*multi-email doctor offline/,
    );
    assert.match(
      rendered,
      /client\tgoogle\tconfiguration_error.*multi-email init --google-client-json <desktop-oauth\.json>/,
    );
    assert.doesNotMatch(rendered, /secret-not-for-output/);
    assert.doesNotMatch(rendered, /diagnostic-secret-must-not-be-printed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor --json emits stable allowlisted JSON Lines and redacts provider details", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-doctor-json-test-"));
  const configPath = path.join(directory, "config.json");
  const config = emptyConfig();
  config.providers.google = {
    clientId: "test.apps.googleusercontent.com",
    clientSecret: "json-secret-not-for-output",
  };
  config.accounts = [
    { alias: "personal", email: "person@example.com", provider: "google" },
    { alias: "work", email: "work@example.com", provider: "google" },
  ];
  const output = [];
  const credentialStore = new MemoryCredentialStore({ sentinel: "unchanged" });

  try {
    await saveConfig(config, configPath);
    await run(["doctor", "--json"], {
      configPath,
      credentialStore,
      output: (line) => output.push(line),
      providerFactory: async () => ({
        async diagnose(account) {
          if (account.alias === "work") {
            const error = new Error("provider-token-must-not-be-printed");
            error.code = "unsafe provider token";
            throw error;
          }
          return {
            alias: "spoofed-alias",
            provider: "spoofed-provider",
            expected_email: "spoofed@example.com",
            credential_present: true,
            token_valid: false,
            identity_verified: null,
            scopes_valid: null,
            credential_source: "legacy",
            legacy_migration_pending: true,
            status: "reauthorization_required",
            error_code: "REAUTHENTICATION_REQUIRED",
            access_token: "provider-token-must-not-be-printed",
          };
        },
      }),
    });

    assert.equal(output.length, 2);
    assert.deepEqual(JSON.parse(output[0]), {
      type: "account",
      alias: "personal",
      provider: "google",
      expected_email: "person@example.com",
      credential_present: true,
      token_valid: false,
      identity_verified: null,
      scopes_valid: null,
      credential_source: "legacy",
      legacy_migration_pending: true,
      status: "reauthorization_required",
      error_code: "REAUTHENTICATION_REQUIRED",
      next_step:
        "multi-email auth personal (or node ./scripts/multi-email auth personal from a Git clone)",
    });
    assert.deepEqual(JSON.parse(output[1]), {
      type: "account",
      alias: "work",
      provider: "google",
      expected_email: "work@example.com",
      credential_present: null,
      token_valid: null,
      identity_verified: null,
      scopes_valid: null,
      credential_source: null,
      legacy_migration_pending: false,
      status: "provider_unavailable",
      error_code: "PROVIDER_DIAGNOSIS_FAILED",
      next_step:
        "multi-email doctor work (or node ./scripts/multi-email doctor work from a Git clone)",
    });
    assert.equal(await credentialStore.get("sentinel"), "unchanged");
    assert.doesNotMatch(output.join("\n"), /json-secret-not-for-output/);
    assert.doesNotMatch(output.join("\n"), /provider-token-must-not-be-printed/);
    assert.doesNotMatch(output.join("\n"), /spoofed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor reports missing config, empty accounts, and unconfigured providers without auth", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-email-doctor-state-test-"));
  const missingPath = path.join(directory, "missing.json");
  const emptyPath = path.join(directory, "empty.json");
  const unconfiguredPath = path.join(directory, "unconfigured.json");
  let providerCalls = 0;
  const dependencies = (configPath, output) => ({
    configPath,
    output: (line) => output.push(line),
    credentialStore: {
      async get() {
        throw new Error("state-only doctor must not read credentials");
      },
    },
    providerFactory: async () => {
      providerCalls += 1;
      throw new Error("state-only doctor must not instantiate providers");
    },
  });

  try {
    const missingOutput = [];
    await run(["doctor", "--json"], dependencies(missingPath, missingOutput));
    assert.deepEqual(JSON.parse(missingOutput[0]), {
      type: "summary",
      alias: null,
      provider: null,
      expected_email: null,
      credential_present: null,
      token_valid: null,
      identity_verified: null,
      scopes_valid: null,
      credential_source: null,
      legacy_migration_pending: false,
      status: "not_configured",
      error_code: null,
      next_step:
        "multi-email setup (or node ./scripts/multi-email setup from a Git clone)",
    });

    const noAccountsConfig = emptyConfig();
    noAccountsConfig.providers.microsoft = {
      clientId: "11111111-2222-3333-4444-555555555555",
      tenant: "organizations",
    };
    await saveConfig(noAccountsConfig, emptyPath);
    const emptyOutput = [];
    await run(["doctor"], dependencies(emptyPath, emptyOutput));
    assert.match(emptyOutput.join("\n"), /no_accounts/);
    assert.match(
      emptyOutput.join("\n"),
      /multi-email add-account <alias> <email> microsoft/,
    );
    assert.match(
      emptyOutput.join("\n"),
      /or node \.\/scripts\/multi-email add-account <alias> <email> microsoft from a Git clone/,
    );

    const unconfigured = emptyConfig();
    unconfigured.accounts = [
      { alias: "m365", email: "person@example.com", provider: "microsoft" },
    ];
    await saveConfig(unconfigured, unconfiguredPath);
    const unconfiguredOutput = [];
    await run(["doctor", "m365", "--json"], dependencies(unconfiguredPath, unconfiguredOutput));
    const record = JSON.parse(unconfiguredOutput[0]);
    assert.equal(record.status, "configuration_error");
    assert.equal(record.error_code, "MICROSOFT_CLIENT_NOT_CONFIGURED");
    assert.equal(
      record.next_step,
      "multi-email set-microsoft-client <application-guid> (or node ./scripts/multi-email set-microsoft-client <application-guid> from a Git clone)",
    );
    assert.equal(providerCalls, 0);
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
