# Multi Email

<p align="center">
  <img src="assets/plugin-icon.png" alt="Multi Email plugin icon" width="128">
</p>

Multi Email is an open-source Codex plugin and MCP server for independently authorized Gmail and Microsoft 365 mailboxes. Every operation names an explicit `account_alias`; there is no implicit active mailbox.

It supports searching, reading, drafting, archiving, read-state changes, Gmail labels, Microsoft categories, and sending through a server-enforced localhost review window.

> **Developer Preview — bring your own OAuth applications.** Multi Email is intended for technical
> users who can configure provider applications and inspect account-by-account diagnostics. The
> release contains no shared Google OAuth client and is not a one-click Gmail connection or a way to
> bypass Google consent, verification, organization, or account policy.
>
> Release status: `0.1.5` is official only when installed from the annotated `v0.1.5` tag or matching
> GitHub release under `lanfuli/multi-email`. The `codex-multi-email` npm package is not yet published;
> verify the repository owner and release tag before installation.

## Why this exists

Most email integrations assume one active account. Multi Email keeps routing explicit so a request can cover several independently authorized accounts without mixing message IDs, drafts, labels, or credentials.

```text
Codex task
  -> Multi Email skill and MCP tools
  -> local Node.js MCP process
  -> Gmail API or Microsoft Graph

OAuth tokens -> macOS Keychain
Account aliases and OAuth app settings -> local mode-0600 config
Mailbox content returned by tools -> Codex conversation/model context
```

The MCP process and credential store run on the Mac, but the end-to-end workflow is not necessarily local-only. Prompts and tool results, including selected mail content, may be processed by Codex/OpenAI according to the user's product, account, and data-control settings. Google and Microsoft also process provider API traffic. See [Security, privacy, and data flow](SECURITY.md#privacy-and-data-flow).

## Safety model

- Every operation requires an explicit `account_alias`.
- Reads are the skill default; mutations require a current, explicit user request.
- Permanent deletion is not exposed.
- Email bodies, attachments, quoted text, signatures, and links are treated as untrusted data, never as tool instructions.
- Search, write-batch, recipient, body, and provider-response sizes are bounded; oversized Gmail, Microsoft identity, and Graph responses are rejected and abandoned at the transport boundary before application parsing.
- Every MCP tool handler has one 108-second budget below the host's 120-second timeout. Provider HTTP calls receive the remaining timeout and an abort signal when supported; an SDK promise that cannot be cancelled is abandoned by the handler at the deadline but may settle later in the background. A timeout before send dispatch is reported as definitely unsent; after dispatch it is an unknown delivery result and is never retried automatically.
- Microsoft batch mutations distinguish completed IDs, definite failures, in-flight unknown outcomes, and untouched remaining IDs so callers do not replay from an inaccurate receipt.
- Sending is blocked until the user reviews the complete supported plain-text draft in a `127.0.0.1` window and clicks Approve.
- A short-lived `approval_request_id` is bound to an effective-send manifest: authenticated principal, mailbox, effective sender identity, draft and thread identity, every recipient, subject, complete body, provider revision, and the verified absence of attachments. Approval expires, is one-use, and is invalidated by any bound change.
- Version `0.1.5` verifies the installed release manifest, every artifact hash and lazy chunk, the CommonJS package boundary, and the current-architecture Keychain runtime before starting. A damaged production install fails as a runtime error and never silently falls back to source or asks users to replace healthy credentials.
- Provider drafts containing HTML, multipart or unknown MIME, inline content, attachments, a malformed mailbox address, an unsupported From/Sender/Reply-To identity, or an incomplete provider revision fail closed before review or send.
- The provider send request is built from the approved allowlisted plain-text fields. Gmail supplies that frozen raw message in the draft-send request; Microsoft uses one MIME `sendMail` request instead of sending a mutable provider draft.
- No MCP tool can approve its own send request.
- A send is never automatically retried after an ambiguous result because the provider may already have accepted it.
- Provider HTTP redirects are rejected, preventing a 307/308 from automatically replaying a mutation, send, or token POST body.

These controls reduce accidental and prompt-injected actions; they do not make OAuth tokens read-only. Google `gmail.modify` and Microsoft `Mail.ReadWrite` plus `Mail.Send` grant material mailbox access.

## Supported operations

| Area | Gmail | Microsoft 365 |
| --- | --- | --- |
| Account identity check | Yes | Yes |
| Credential, token, scope, and identity diagnosis | One alias or all, without reading mail | One alias or all, without reading mail |
| Provider-native search and message read | Yes | Yes |
| New and reply drafts | Yes | Yes |
| Draft update | Yes | Yes |
| Archive and read/unread | Yes | Yes |
| Labels/categories | List and modify label IDs | Modify an exact known category name |
| Human-reviewed frozen send | Local full-review window | Local full-review window; source draft is retained |

The plugin does not intentionally call provider attachment-content endpoints, expose attachment contents through MCP, permanently delete mail, operate calendars, expose arbitrary provider APIs, or automatically enable send-as aliases, delegated identities, or shared mailboxes. Gmail `format=full` responses can still deliver small inline MIME-part bytes to the local process; they are not returned by the tool. Message reads expose attachment names only. Drafts created by the plugin are plain text. Provider drafts containing HTML, inline content, attachments, malformed mailbox addresses, or unsupported identities cannot pass the send-review gate.

Search queries are provider-native: Gmail search syntax for Google and Microsoft Graph mail search syntax for Microsoft 365.

`mail_list_accounts` reports whether a local credential exists with `credentialPresent` and `connectionStatus` (`credential_present_unverified` or `not_authorized`). Those fields are not authentication claims. Use `mail_diagnose_accounts` to verify current token, scope, and provider-identity health.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 22 or newer
- Codex desktop or CLI with local stdio MCP and plugin support
- A user-owned [Google Cloud Desktop OAuth client](docs/google-oauth.md) with Gmail API enabled for
  Gmail accounts
- A [Microsoft Entra public-client application](docs/microsoft-entra.md) for Microsoft 365 accounts

The committed `dist/` bundle contains its JavaScript dependencies and both macOS Keychain native binaries, so a Git marketplace snapshot can start without a committed `node_modules/` directory. Development and npm-library imports still use normal npm dependencies.

## Install from GitHub

The most transparent install is a local clone:

```bash
git clone https://github.com/lanfuli/multi-email.git
cd multi-email
git checkout --detach v0.1.5
node ./scripts/multi-email self-test
codex plugin marketplace add "$(pwd)"
codex plugin add multi-email@multi-email
```

`self-test` verifies the release bundle without reading config, Keychain, provider state, or mail. Start a new Codex task after installation so the skill and MCP tools are discovered, then call `mail_get_runtime_info` to confirm that the running MCP process reports the expected version and a verified build.

Codex also accepts a Git marketplace source once the repository exists:

```bash
codex plugin marketplace add lanfuli/multi-email --ref v0.1.5
codex plugin add multi-email@multi-email
```

The explicit `--ref` keeps the installed snapshot on the reviewed release instead of the moving default branch. The repo marketplace entry uses the documented repo-root local source (`"./"`). The current documented Codex marketplace schema also has URL, git-subdir, and npm source forms; this repo does not use an npm source because no npm publication has occurred.

The marketplace installs the plugin skill and MCP server; it does not place the setup CLI on your shell `PATH`. The setup examples below therefore run from the matching reviewed local clone. A future npm installation can use the equivalent `multi-email ...` binary directly; do not run `npm run setup` from a consuming project.

## Recommended guided setup (optional)

[Computer Use](https://learn.chatgpt.com/docs/computer-use) can optionally guide the Google Cloud
Console steps in the user's browser. It is a separate Codex plugin, not a Multi Email dependency.
Install and enable it from Codex Plugins, turn on its server and skill toggles, and grant the
documented macOS Screen Recording and Accessibility permissions; if it is unavailable or the user
prefers not to grant browser control, follow the manual
[Google OAuth guide](docs/google-oauth.md) instead.

For the Google Auth Platform Desktop client used by this Gmail workflow, Google's supported setup is
the Cloud Console rather than an API. IAM/IAP OAuth-client APIs are a different product surface and
do not create this Gmail Desktop client. Computer Use can navigate and explain the page, but it
cannot provision a client behind the user's back. See Google's
[OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

Paste this into a new Codex task after installing Multi Email and, for browser guidance, Computer Use:

> Use $multi-email to set up my user-owned Google Cloud Desktop OAuth client, using Computer Use if
> available, then connect my requested Gmail aliases one at a time. Follow the assisted onboarding
> confirmation and credential-handling safeguards.

The user—not Computer Use or Multi Email—makes the publishing, credential-creation, legal, and
Gmail-consent decisions. Computer Use stops before Create; the user clicks it, downloads the
credential, and closes the dialog before returning control. Provide only the downloaded file's local
path; Computer Use must not inspect, copy, or repeat any credential value. Guided setup does not
change the Developer Preview or BYO OAuth boundaries above. For an External app, the guide also
explains the seven-day Testing limit versus In production and asks before changing publishing
status; it never treats Production as verification or submits legal/compliance claims automatically.

## Configure OAuth

Run the non-interactive, read-only preflight first. It does not open a browser, read Keychain, or contact an email provider:

```bash
node ./scripts/multi-email setup
```

For the provider-side setup, follow the detailed [Google OAuth guide](docs/google-oauth.md) or
[Microsoft Entra guide](docs/microsoft-entra.md). Both use OAuth applications you control; the
release package contains no shared Google client or maintainer-owned authorization fallback. Do not
share client files, authorization URLs, codes, or tokens.

One Multi Email config has one Google OAuth client. Every Google alias in that config uses that same
client, while each mailbox still receives and stores its own authorization. This intentionally keeps
the connection model simple; it does not support selecting a different Google Cloud project per
alias inside one config.

Importing the Desktop JSON stores its client ID and client secret in Multi Email's mode-`0600` local
config; mailbox tokens are stored in macOS Keychain. The CLI does not delete the downloaded JSON.
After initialization and successful per-alias diagnosis, move it to an owner-only private location
or delete it yourself if you no longer want the extra copy; Multi Email never does that automatically.

The default config path is:

```text
~/.config/codex-multi-email/config.json
```

Set `CODEX_MULTI_EMAIL_CONFIG` to use another absolute path. The setup CLI creates a missing config directory with mode `0700`, leaves an existing parent directory's permissions unchanged, writes the config file with mode `0600`, and refuses a config target that is a symlink or non-regular file.

Initialize either provider independently, or supply both provider settings in one command.

Google only:

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/path/to/desktop-oauth.json
```

Microsoft only:

```bash
node ./scripts/multi-email init \
  --microsoft-client-id <entra-application-client-id> \
  --microsoft-tenant organizations
```

Both providers:

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/path/to/desktop-oauth.json \
  --microsoft-client-id <entra-application-client-id> \
  --microsoft-tenant organizations
```

### Replace an existing Google client

Changing the Google client affects every Google alias in the config. Schedule a maintenance window:
the client setting changes before the aliases are reauthorized, so the migration is not one atomic
all-account transaction.

Import the replacement Desktop client only when you intend to migrate the complete Google profile:

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/private/path/to/replacement-desktop-client.json \
  --confirm
```

`--confirm` is required only when the imported Google client ID differs from the configured client.
It is not required for the first Google setup or when the same client is imported again.

Do **not** begin by running `logout`, `revoke`, deleting Keychain items, or removing aliases. Those
actions reduce the available recovery options without making the new client more likely to work.
After the client changes, reauthorize and diagnose every existing Google alias separately:

```bash
node ./scripts/multi-email auth <google-alias> --browser <default|safari|chrome> --force
node ./scripts/multi-email doctor <google-alias> --json
```

Repeat those two commands for each Google alias, one at a time. The migration is complete only when
each one reports `status=ok` with credential, token, scope, and identity checks true. If migration
stops partway through, do not assume that restoring either client will restore the whole group:
credentials already replaced belong to the new client, while untouched credentials belong to the
old client. Restore deliberately and rerun `doctor` for every alias; there is no automatic
whole-profile rollback.

To add or replace Microsoft settings later:

```bash
node ./scripts/multi-email set-microsoft-client <entra-application-client-id> \
  --microsoft-tenant organizations
```

Add and authorize each mailbox independently. Choose the browser explicitly when browser session state matters; the allowed values are `default`, `safari`, and `chrome`:

```bash
node ./scripts/multi-email add-account gmail-01 <gmail-address> google
node ./scripts/multi-email auth gmail-01 --browser safari

node ./scripts/multi-email add-account m365-main <microsoft-365-address> microsoft
node ./scripts/multi-email auth m365-main --browser chrome

node ./scripts/multi-email list
node ./scripts/multi-email doctor
node ./scripts/multi-email doctor --json
```

Authorization starts with a local preflight that displays the exact alias, expected mailbox, provider, browser, requested scopes, and existing health. An alias whose credential, token, scopes, and identity are already healthy is skipped by default; use `--force` only when you intentionally want to replace that healthy authorization.

After the browser flow, run `doctor` for the same alias. Its human table shows both the configured `EXPECTED EMAIL` and a `VERIFIED EMAIL`; the latter is populated only after the credential, token, scopes, and provider identity all pass. `doctor --json` and `mail_diagnose_accounts` return the same allowlisted per-alias health record and safe `next_step`. One alias failing diagnosis does not hide the other aliases. The developer or support email shown on a Google consent screen identifies the OAuth application, not the mailbox being connected.

Credential replacement is verified as a Keychain transaction. If writing or reading back a new credential fails, Multi Email restores and verifies the previous value (or removes an unverifiable first value). `CREDENTIAL_ROLLBACK_FAILED` means the final Keychain state could not be confirmed; stop and inspect that alias instead of retrying OAuth.

Use placeholders only in documentation; do not commit real addresses, OAuth client JSON, generated config, authorization URLs, codes, or tokens.

### Google OAuth

Google authorization requests `openid`, `email`, and `gmail.modify` through a loopback Desktop OAuth
flow with PKCE and explicit account selection. Token info must belong to the configured Google
client and contain the required scopes, the returned Gmail profile must exactly match the configured
address, and the Keychain write must be read back before success is reported.

See [Configure Google OAuth for Gmail](docs/google-oauth.md) for the current Cloud Console checklist and common blockers.

Google classifies `gmail.modify` as a restricted scope. For an External app in **Testing**, Google
states that test-user authorizations expire seven days after consent, including an offline refresh
token; that mode is therefore unsuitable for a durable connection. See Google's
[app-audience documentation](https://support.google.com/cloud/answer/15549945?hl=en). Moving an app to
**Production** changes the Testing lifecycle but does not make it verified, remove every warning, or
override account and organization policy.

Bring-your-own OAuth credentials do not exempt an app or user from Google's verification,
consent-screen, test-user, restricted-scope, organization, quota, retention, or user-data
requirements.

### Microsoft OAuth

Microsoft authorization uses MSAL system-browser interactive authorization and requests delegated `User.Read`, `Mail.ReadWrite`, and `Mail.Send`. The `/me` profile must match the configured identity and the Keychain write must be verified before success is reported. Tenant policy or administrator consent can block these scopes.

See [Configure Microsoft Entra for Microsoft 365 mail](docs/microsoft-entra.md) for the exact desktop redirect and delegated-permission setup.

## Use in Codex

Always name the account alias:

- “Use `gmail-01` to find unread messages from the last two days.”
- “Across `gmail-01` and `m365-main`, summarize messages that need my reply without making changes.”
- “Create a reply draft in `m365-main`; do not send it.”
- “Diagnose all configured accounts without reading or changing mail.”

For a send:

1. Ask Codex to prepare the selected draft for review.
2. Inspect the authenticated identity, effective From/Sender/Reply-To, every recipient, subject, threading headers, format, attachment status, and complete plain-text body in the localhost window opened by the MCP server.
3. Click Approve or Reject in that window.
4. Return to Codex and explicitly confirm that the local review is complete.
5. The server rebuilds the effective-send manifest, spends the one-use approval, rechecks the provider revision, and freezes the approved allowlisted fields into one send request.
6. A Microsoft frozen send intentionally retains the original source draft because Graph's existing-draft send action has no conditional revision guard. Check the result field `sourceDraftRetained`; do not send that retained draft again without a new review.

Do not paste the local review URL, cookies, nonces, fingerprints, OAuth values, or Keychain contents into Codex or an issue.

## Update

For a local clone marketplace:

```bash
git fetch origin --tags
git checkout --detach v0.1.5
codex plugin add multi-email@multi-email
```

Replace `v0.1.5` only with a newer annotated release tag that you have reviewed. A Git marketplace installed with `--ref` stays pinned, so move it to a new release explicitly:

```bash
codex plugin remove multi-email@multi-email
codex plugin marketplace remove multi-email
codex plugin marketplace add lanfuli/multi-email --ref v0.1.5
codex plugin add multi-email@multi-email
```

Start a new Codex task after reinstalling. Verify the new checkout with `node ./scripts/multi-email self-test`, confirm the live MCP build with `mail_get_runtime_info`, and then run `doctor` for each alias. Do not reauthorize an account merely because a previous damaged runtime reported a token error.

## Uninstall and remove local data

Remove the plugin and marketplace:

```bash
codex plugin remove multi-email@multi-email
codex plugin marketplace remove multi-email
```

Plugin removal does not delete OAuth credentials or config. Prefer the guarded lifecycle commands before deleting the clone:

```bash
node ./scripts/multi-email logout <alias> --confirm
node ./scripts/multi-email revoke <alias> --confirm
```

`logout` removes local credentials. `revoke` also attempts provider-side revocation where the provider safely supports it; Microsoft may require removal through Microsoft My Apps followed by `logout`. Inspect the command result rather than assuming provider revocation succeeded.

Current Keychain items use service `io.github.lanfuli.multi-email`. Historical installations may also have verified legacy items under `com.openai.codex.multi-email`; the credential store migrates only after validating the provider identity, while `doctor` is deliberately read-only and never migrates. Use macOS Keychain Access for optional legacy cleanup, and inspect the exact config path before deleting `~/.config/codex-multi-email/config.json`.

## Development

```bash
npm ci
npm run validate
npm run pack:check
npm audit --omit=dev --audit-level=high
```

`npm run build` uses the exact `@vercel/ncc` version in `package-lock.json`, emits the CommonJS bundle `dist/server.cjs`, and includes both `keyring.darwin-arm64.node` and `keyring.darwin-x64.node`. CommonJS is intentional because the native Keychain loader relies on Node's `__filename`/`createRequire` behavior. The cold-install check tests both a dependency-free Git snapshot and an installed npm tarball.

The package metadata is structurally ready for a future public npm package named `codex-multi-email`, but this README does not claim that the name is reserved or that a package is published. A maintainer must authenticate, verify ownership, inspect `npm publish --dry-run`, and explicitly publish.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).

## Troubleshooting

- **Unknown alias:** run `node ./scripts/multi-email list`, then use the exact alias on every call.
- **Plugin fails after install or restart:** run `node ./scripts/multi-email self-test --json` from the matching reviewed checkout and inspect `mail_get_runtime_info` when the MCP starts. The package, Plugin manifest, Skill `metadata.version`, bundled runtime, and build manifest must identify the same release. On any mismatch, restart or reinstall that pinned release; do not reauthorize a mailbox.
- **Connection health unclear:** call `mail_diagnose_accounts` for one alias or all aliases; it checks credential presence, token usability, scopes, and identity without reading messages or making writes.
- **CLI or automation diagnosis:** run `node ./scripts/multi-email doctor --json` for stable JSON Lines with safe next steps. It does not read messages or migrate credentials.
- **Not authorized or token expired:** first run `doctor` for that alias. Reauthorize only when its result explicitly requires it, using `node ./scripts/multi-email auth <alias> --browser default|safari|chrome`; never paste a token into chat.
- **Review request expired/rejected:** prepare a new review and make a new decision in the local window.
- **Draft changed after approval:** review the complete new draft again.
- **Draft not reviewable:** remove HTML, inline content, attachments, alternate sender identities, or extra Reply-To values, or recreate it as a plain-text draft through Multi Email. Do not bypass the gate.
- **Send result uncertain:** do not retry; inspect Drafts and Sent read-only first.
- **Partial Microsoft batch result:** use `completedIds` and `remainingIds` plus either `failedId` or `unknownOutcomeId` from the error details. Inspect an unknown outcome read-only before deciding whether to retry, and never replay the full original batch.
- **Gmail authorization warning or block:** an app developer/support email is not the target mailbox. An unverified-app page that offers an Advanced continuation is a user trust decision that Multi Email never clicks; a hard “This app is blocked” result should stop browser-switch retries and trigger checks of audience, publishing state, test-user membership, scope, verification, and account/organization policy.
- **Microsoft consent blocked:** verify public-client settings, tenant choice, delegated permissions, and administrator policy.
- **Shared mailbox or alternate From address:** unsupported until the exact delegated identity and permissions are implemented and verified end to end.

## License

MIT © 2026 Vincent_Lan. See [LICENSE](LICENSE).
