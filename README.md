# Multi Email

Multi Email is an open-source Codex plugin and MCP server for independently authorized Gmail and Microsoft 365 mailboxes. Every operation names an explicit `account_alias`; there is no implicit active mailbox.

It supports searching, reading, drafting, archiving, read-state changes, Gmail labels, Microsoft categories, and sending through a server-enforced localhost review window.

> Release status: `0.1.2` is official only when installed from the annotated `v0.1.2` tag or matching GitHub release under `lanfuli/multi-email`. The `codex-multi-email` npm package is not yet published; verify the repository owner and release tag before installation.

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
- Search, write-batch, recipient, and body sizes are bounded.
- Sending is blocked until the user reviews the complete supported plain-text draft in a `127.0.0.1` window and clicks Approve.
- A short-lived `approval_request_id` is bound to an effective-send manifest: authenticated principal, mailbox, effective sender identity, draft and thread identity, every recipient, subject, complete body, provider revision, and the verified absence of attachments. Approval expires, is one-use, and is invalidated by any bound change.
- Version `0.1.2` fails closed before review or send when a provider draft contains HTML, multipart or unknown MIME, inline content, attachments, a malformed mailbox address, an unsupported From/Sender/Reply-To identity, or an incomplete provider revision.
- The provider send request is built from the approved allowlisted plain-text fields. Gmail supplies that frozen raw message in the draft-send request; Microsoft uses one MIME `sendMail` request instead of sending a mutable provider draft.
- No MCP tool can approve its own send request.
- A send is never automatically retried after an ambiguous result because the provider may already have accepted it.

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

The plugin does not intentionally call provider attachment-content endpoints, expose attachment contents through MCP, permanently delete mail, operate calendars, expose arbitrary provider APIs, or automatically enable send-as aliases, delegated identities, or shared mailboxes. Gmail `format=full` responses can still deliver small inline MIME-part bytes to the local process; they are not returned by the tool. Message reads expose attachment names only. Drafts created by the plugin are plain text. Provider drafts containing HTML, inline content, attachments, malformed mailbox addresses, or unsupported identities cannot pass the send-review gate in version `0.1.2`.

Search queries are provider-native: Gmail search syntax for Google and Microsoft Graph mail search syntax for Microsoft 365.

`mail_list_accounts` reports whether a local credential exists with `credentialPresent` and `connectionStatus` (`credential_present_unverified` or `not_authorized`). Those fields are not authentication claims. Use `mail_diagnose_accounts` to verify current token, scope, and provider-identity health.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 22 or newer
- Codex desktop or CLI with local stdio MCP and plugin support
- A Google Cloud Desktop OAuth client with Gmail API enabled for Gmail accounts
- A Microsoft Entra public-client application for Microsoft 365 accounts

The committed `dist/` bundle contains its JavaScript dependencies and both macOS Keychain native binaries, so a Git marketplace snapshot can start without a committed `node_modules/` directory. Development and npm-library imports still use normal npm dependencies.

## Install from GitHub

The most transparent install is a local clone:

```bash
git clone https://github.com/lanfuli/multi-email.git
cd multi-email
git checkout --detach v0.1.2
node ./scripts/multi-email --help
codex plugin marketplace add "$(pwd)"
codex plugin add multi-email@multi-email
```

Start a new Codex task after installation so the skill and MCP tools are discovered.

Codex also accepts a Git marketplace source once the repository exists:

```bash
codex plugin marketplace add lanfuli/multi-email --ref v0.1.2
codex plugin add multi-email@multi-email
```

The explicit `--ref` keeps the installed snapshot on the reviewed release instead of the moving default branch. The repo marketplace entry uses the documented repo-root local source (`"./"`). The current documented Codex marketplace schema also has URL, git-subdir, and npm source forms; this repo does not use an npm source because no npm publication has occurred.

The setup examples below run from the matching local clone. A future npm installation can use the equivalent `multi-email ...` binary directly; do not run `npm run setup` from a consuming project.

## Configure OAuth

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

To add or replace Microsoft settings later:

```bash
node ./scripts/multi-email set-microsoft-client <entra-application-client-id> \
  --microsoft-tenant organizations
```

Add and authorize each mailbox independently:

```bash
node ./scripts/multi-email add-account gmail-01 <gmail-address> google
node ./scripts/multi-email auth gmail-01

node ./scripts/multi-email add-account m365-main <microsoft-365-address> microsoft
node ./scripts/multi-email auth m365-main

node ./scripts/multi-email list
node ./scripts/multi-email doctor
```

Use placeholders only in documentation; do not commit real addresses, OAuth client JSON, generated config, authorization URLs, codes, or tokens.

### Google OAuth

Google authorization requests `openid`, `email`, and `gmail.modify` through a loopback Desktop OAuth flow. The returned Gmail profile must exactly match the configured address before tokens are stored in Keychain.

Bring-your-own OAuth credentials do not exempt an app or user from Google's verification, consent-screen, test-user, restricted-scope, organization, quota, or retention requirements. An OAuth project left in Testing can behave differently from a verified production app, and individual accounts or administrators can still block access.

### Microsoft OAuth

Microsoft authorization uses MSAL system-browser interactive authorization and requests delegated `User.Read`, `Mail.ReadWrite`, and `Mail.Send`. The `/me` profile must match the configured identity before the MSAL cache is stored. Tenant policy or administrator consent can block these scopes.

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
git checkout --detach v0.1.2
codex plugin add multi-email@multi-email
```

Replace `v0.1.2` only with a newer annotated release tag that you have reviewed. A Git marketplace installed with `--ref` stays pinned, so move it to a new release explicitly:

```bash
codex plugin remove multi-email@multi-email
codex plugin marketplace remove multi-email
codex plugin marketplace add lanfuli/multi-email --ref v0.1.2
codex plugin add multi-email@multi-email
```

Start a new Codex task after reinstalling.

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
- **Connection health unclear:** call `mail_diagnose_accounts` for one alias or all aliases; it checks credential presence, token usability, scopes, and identity without reading messages or making writes.
- **Not authorized or token expired:** rerun `node ./scripts/multi-email auth <alias>`; never paste a token into chat.
- **Review request expired/rejected:** prepare a new review and make a new decision in the local window.
- **Draft changed after approval:** review the complete new draft again.
- **Draft not reviewable:** remove HTML, inline content, attachments, alternate sender identities, or extra Reply-To values, or recreate it as a plain-text draft through Multi Email. Do not bypass the gate.
- **Send result uncertain:** do not retry; inspect Drafts and Sent read-only first.
- **Gmail authorization blocked:** verify the OAuth consent screen, test-user status, requested Gmail scope, account/organization policy, and app verification state.
- **Microsoft consent blocked:** verify public-client settings, tenant choice, delegated permissions, and administrator policy.
- **Shared mailbox or alternate From address:** unsupported until the exact delegated identity and permissions are implemented and verified end to end.

## License

MIT © 2026 Vincent_Lan. See [LICENSE](LICENSE).
