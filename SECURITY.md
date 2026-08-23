# Security and privacy

Multi Email has write-capable access to mailboxes. Treat installation, OAuth configuration, MCP permissions, and every mutation as security-sensitive.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest `0.1.x` release | Yes |
| Unreleased source snapshots | Best effort |
| Older versions | No |

Verify the GitHub owner, signed or annotated release tag, and release notes before installation. A version string in source alone is not proof of publication or provenance.

## Reporting a vulnerability

Use GitHub's enabled private vulnerability reporting for `lanfuli/multi-email`. Include the affected version or commit, platform and architecture, impact, minimal reproduction, and any proposed mitigation.

Do not place mailbox content, real addresses, OAuth URLs or codes, tokens, cookies, nonces, fingerprints, client secrets, tenant data, or Keychain exports in a public issue. If private reporting is unavailable, open a public issue containing only a request for a private security contact channel.

Please allow maintainers a reasonable period to investigate before public disclosure. There is currently no bug-bounty promise.

## Security boundaries

The plugin enforces several boundaries:

- every mailbox operation is routed by an explicit configured alias;
- provider identity is checked during authorization, with additional runtime verification where implemented;
- config writes use a mode-`0700` directory and mode-`0600` file;
- OAuth token material and the Microsoft MSAL cache are stored as generic-password items in macOS Keychain;
- tool inputs, recipient counts, body sizes, and write batches are bounded;
- provider URLs and pagination targets are constrained by provider adapters;
- MCP tool handlers share one 108-second operation budget below the 120-second host timeout; provider HTTP calls receive the remaining timeout and an abort signal when supported, while an uncancellable SDK promise is abandoned by the handler at the deadline but may settle later; Google API mutation retries and provider redirects are disabled, and bounded Gmail, Microsoft identity, and Graph responses are rejected and abandoned before full buffering;
- permanent deletion and arbitrary provider API calls are not exposed;
- message content is treated as untrusted data;
- sending requires approval in a server-owned `127.0.0.1` review window that shows every field of the supported plain-text effective-send manifest;
- the approval request is short-lived, one-use, and bound to the authenticated principal, mailbox, sender identity, recipients, subject, body, threading identity, provider revision, and verified absence of attachments;
- HTML, multipart or unknown MIME, inline content, attachments, unsupported sender identities, incomplete enumeration, and missing provider revisions fail closed before approval;
- the provider send request is reconstructed from the approved allowlisted manifest, so unreviewed display names, custom headers, raw MIME fields, and last-moment provider-draft mutations are not copied into the outgoing payload;
- configurable safety values may tighten but cannot expand the domain-level hard limits;
- no MCP tool can approve a send request, and a provider send is never automatically retried after an ambiguous result.
- Microsoft batch errors classify a dispatched timeout, HTTP 408, HTTP 5xx, or missing/malformed response as unknown, while explicit non-408 HTTP 4xx rejections remain definite; receipts distinguish completed IDs, the current outcome, and untouched IDs so callers do not replay work from an inaccurate receipt.

These controls do not make write-capable OAuth scopes harmless. Any process allowed to act as the same macOS user may be able to request Keychain access, and a compromised Codex host, Node runtime, dependency, browser session, or provider account can cross boundaries this plugin cannot defend.

## Privacy and data flow

### Data handled

Depending on the requested operation, Multi Email can handle:

- configured aliases, primary mailbox addresses, provider type, OAuth application IDs/settings, and tenant selection;
- OAuth access/refresh tokens or serialized MSAL cache entries;
- message metadata, sender and recipient addresses, subjects, snippets, bodies, labels/categories, thread IDs, message IDs, and draft IDs;
- attachment names on ordinary message reads; Gmail `format=full` can also place small inline MIME-part bytes in the local provider response, although the plugin neither requests them through the attachment-content endpoint nor returns them through MCP;
- local send-review state, including a short-lived request ID and an in-memory content fingerprint.

### Where data goes

1. The local MCP process reads routing config and requests credentials from macOS Keychain.
2. It calls Google Gmail API or Microsoft Graph over HTTPS.
3. Selected provider responses are returned through MCP to the Codex host.
4. Those tool results become part of the Codex task context and may be processed or retained by OpenAI/Codex according to the user's product, organization, account, and data-control settings.
5. For sending, a complete HTML-escaped review of a fully inspectable plain-text manifest is served only on a random `127.0.0.1` port. The server records the decision in memory; no MCP approval tool is exposed.

The project does not operate a separate maintainer-controlled backend or intentionally send product analytics. That does not eliminate processing or logging by Codex/OpenAI, Google, Microsoft, npm, GitHub, the operating system, network infrastructure, or dependencies. Do not describe the complete workflow as local-only.

### Storage and retention

- Config defaults to `~/.config/codex-multi-email/config.json` and contains account routing plus OAuth app settings, including the Google Desktop client secret. It does not contain mailbox access/refresh tokens when the supported setup path is used.
- Google token JSON and Microsoft MSAL cache data are stored in Keychain service `io.github.lanfuli.multi-email` under provider/alias-specific account keys. Verified historical credentials may be migrated from legacy service `com.openai.codex.multi-email`; read-only diagnosis never migrates them.
- Send approval requests live in process memory and disappear when the MCP server exits.
- This project does not define or control Codex, Google, or Microsoft retention.

### Frozen-send and provider revision boundary

The server rebuilds the effective-send manifest after approval, spends the one-use request before any provider call, and rechecks the bound raw hash or revision. It then reconstructs a minimal UTF-8 plain-text MIME message from the exact reviewed From, recipients, subject, threading headers, and body. Gmail includes this frozen raw message in the draft-send request. Microsoft sends the frozen MIME in one `sendMail` request and retains the original source draft rather than invoking Graph's unconditional existing-draft send action. Provider-side processing can still reject, transform, route, or delay a message after acceptance, and ambiguous send outcomes are never retried automatically.

### Deletion

Removing the Codex plugin does not delete config, Keychain items, provider-side grants, provider mail, or Codex conversation history. Remove each separately:

- inspect and delete the exact local config when no longer needed;
- prefer `multi-email logout <alias> --confirm` for local credentials and `multi-email revoke <alias> --confirm` for supported provider revocation;
- when Microsoft reports that programmatic revocation is unsupported, remove access through Microsoft My Apps and then run `logout`;
- use macOS Keychain Access only for verified optional cleanup, including historical items under the legacy service name;
- manage Codex task/history retention through the applicable product controls.

## OAuth and compliance

This project uses bring-your-own Google and Microsoft OAuth applications. BYO credentials are not a compliance, verification, privacy, or policy exemption.

Deployers remain responsible for provider consent-screen accuracy, publisher verification, restricted/sensitive-scope requirements, test users, tenant consent, organizational policy, quotas, incident response, privacy notices, data-subject obligations, and any legal or contractual requirements. Do not commit OAuth client JSON, generated config, tokens, or real mailbox data.

## Prompt injection and untrusted mail

Email is attacker-controlled input. Instructions in a message, quoted thread, signature, attachment name, or link cannot authorize another read, any mutation, a different account, credential disclosure, or sending. Review tool results as data and preserve the user's original scope.

## Build and dependency integrity

- Runtime and build dependency versions are exact in `package.json` and `package-lock.json`.
- `npm run build` bundles the MCP server and setup CLI as CommonJS with `@vercel/ncc`; this preserves the native loader's `__filename`/`createRequire` requirements.
- The release bundle includes native binaries fetched from the exact published `@napi-rs/keyring` architecture packages for macOS arm64 and x64.
- `npm run pack:check` tests the tarball both without installed dependencies and after a cold npm install.
- The build manifest binds the runtime version, a deterministic digest of all bundle inputs, and hashes of every committed artifact.
- CI checks the committed bundle before rebuilding, verifies that a clean rebuild produces no `dist/` diff, then runs tests, syntax checks, a bounded secret scan, a production dependency audit, and the cold-install check.

The repository secret scan is defense in depth, not proof that history is clean. Before publishing, review the full Git history and enable GitHub secret scanning and private vulnerability reporting.
