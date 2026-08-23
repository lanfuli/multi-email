# Install and runtime checks

Keep three layers separate:

1. **Plugin runtime:** Codex can discover and start the installed MCP bundle.
2. **Provider configuration:** Google Desktop OAuth settings or a Microsoft Entra application client ID exist.
3. **Per-alias credential:** one mailbox has a valid token, identity, and scopes.

A failure in one layer does not prove the next layer is broken.

## Reuse before installing

- Inspect the existing plugin, reviewed checkout, config, and CLI path before installing another copy.
- Do not overwrite config, Keychain entries, cookies, tokens, or browser login state merely to test availability.
- A marketplace plugin install does not place `multi-email` on the shell `PATH`. Use `node ./scripts/multi-email ...` from the reviewed checkout matching the installed release unless a separate CLI installation is confirmed.

For a new installation, pin a reviewed release rather than a moving branch. Resolve the actual reviewed tag first, then use the repository's current installation documentation. The local-clone flow has this shape:

```bash
git clone https://github.com/lanfuli/multi-email.git
cd multi-email
git checkout --detach <reviewed-tag>
node ./scripts/multi-email setup
codex plugin marketplace add "$(pwd)"
codex plugin add multi-email@multi-email
```

Do not run `<reviewed-tag>` literally. Start a new Codex task or restart after installation so the skill and MCP tools are rediscovered.

## Read-only preflight

From the matching checkout:

```bash
node ./scripts/multi-email setup
node ./scripts/multi-email list
```

`setup` checks local configuration without reading credentials or contacting a provider. `list` shows configured aliases but does not prove their tokens work.

Provider setup, when actually missing, uses one of these paths:

```bash
node ./scripts/multi-email init --google-client-json /absolute/private/path/to/desktop-client.json
node ./scripts/multi-email set-microsoft-client <application-guid> --microsoft-tenant organizations
```

For a brand-new config, Microsoft can instead be initialized with `init --microsoft-client-id ...`. Never paste or commit a Google client JSON, client secret, token, or MSAL cache. Multi Email's Microsoft desktop flow uses a public-client application and does not need a client secret.

Add each configured mailbox with its own stable alias only after its provider client is configured:

```bash
node ./scripts/multi-email add-account <alias> <email> <google|microsoft>
```

Then follow [oauth-onboarding.md](oauth-onboarding.md).

## After install or restart: test runtime first

Do not begin by reauthorizing accounts.

1. From the matching reviewed checkout, run `node ./scripts/multi-email self-test --json`. It must report the expected version and verified release artifacts without reading config, Keychain, provider state, or mail.
2. Call `mail_get_runtime_info`. It must identify the live MCP version/build and report verified integrity; this proves the restarted process is using the expected installed bundle.
3. Call `mail_list_accounts`. If it returns structured account data, the MCP server and account-routing layer loaded.
4. Call `mail_diagnose_accounts` for one alias previously known to be healthy. This exercises credential access plus the provider-specific runtime path without reading mail or making writes.
5. If that passes, diagnose the remaining aliases and reauthorize only those whose own records require it.

If MCP tools are not discovered, the server cannot start, or the process reports a module, lazy chunk, native binding, load, or package error, classify it as an install/runtime failure. Do not delete tokens, open OAuth, or translate it into `reauthorization_required`. Verify the installed snapshot matches the reviewed release and repair or reinstall that package first.

If `mail_list_accounts` works but provider diagnosis fails:

- A provider client error such as `MICROSOFT_CLIENT_NOT_CONFIGURED` is configuration, not a missing mailbox token.
- `credential_present=false` or `not_authorized` is per-alias authorization.
- A provider/network error is neither until a later doctor result proves token, identity, or scope failure.
- If every previously healthy alias fails with the same runtime-shaped error after restart, investigate the shared runtime before touching account credentials.

For source or release-maintainer diagnosis, use the repository's existing validation and cold-install checks. Do not patch an installed cache or rebuild/publish a release as an onboarding shortcut.

## Runtime acceptance

Runtime onboarding is complete only when:

- Codex discovers the Multi Email MCP tools after restart.
- `mail_list_accounts` returns the expected aliases.
- At least one known-good provider path completes diagnosis.
- Each intended alias is then classified independently by the four doctor checks in [oauth-onboarding.md](oauth-onboarding.md).

None of these checks authorize reading mail, modifying mail, or sending a message.
