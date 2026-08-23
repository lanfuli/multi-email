# Per-account OAuth onboarding

Onboard one alias at a time. A browser callback or a user saying “done” is not sufficient evidence; the same alias must pass `doctor` before moving on.

## Establish the inventory

1. List the configured `alias`, expected email, and provider with `mail_list_accounts` or, from the reviewed matching checkout:

   ```bash
   node ./scripts/multi-email list
   ```

2. Diagnose each listed alias separately and read-only with `mail_diagnose_accounts` using that explicit `account_alias`, or run this once per alias:

   ```bash
   node ./scripts/multi-email doctor <alias> --json
   ```

3. Build a per-alias status list from those individual results. Skip an alias only when its record has all four checks true—`credential_present`, `token_valid`, `identity_verified`, and `scopes_valid`—and `status` is `ok`.

Do not reauthorize every account as a default. Do not delete Keychain entries, browser state, or working tokens merely to verify them.

## Keep the Google client boundary explicit

The release contains no shared Google OAuth client. One Multi Email config has one user-owned Google
Desktop client shared by every Google alias in that config; each alias still has an independent
mailbox credential. An External app left in Testing grants these non-basic scopes for seven days,
including the offline refresh token. Production is not the same as Google verification and does not
bypass account or organization policy.

If an existing Google client ID must change, plan a maintenance window and run the guarded import:

```bash
node ./scripts/multi-email init --google-client-json <desktop-oauth.json> --confirm
```

Do not first run `logout`, `revoke`, delete Keychain items, or remove aliases. The provider setting
changes before all aliases can be reauthorized, so the migration is not atomic and has no automatic
whole-config rollback. For every Google alias, run `auth <alias> --force` with the intended browser,
then `doctor <alias> --json`; move on only after that alias is fully healthy.

## Authorize exactly one alias

Before opening OAuth, tell the user the exact tuple:

```text
alias=<alias>; expected email=<email>; provider=<google|microsoft>; browser=<requested browser or system default>
```

- Honor the requested browser. If the launcher can only use the system default and the requested browser cannot be guaranteed, say so before launching; never silently switch browsers or aliases.
- Do not select a mailbox merely because it is already signed in or was previously authorized in Chrome, Safari, or another browser. The configured alias determines the target; let the user choose the exact expected identity in the account picker.
- The developer, app-owner, publisher, or support email shown on a consent page identifies the OAuth application. It is not proof of which mailbox is being authorized. Compare the browser's selected Google/Microsoft identity with the expected email above.
- Hand passwords, passkeys, Touch ID, MFA, verification codes, account selection, and consent decisions to the user.
- Run authorization only from a reviewed checkout of the matching release unless a separate CLI install is known:

  ```bash
  node ./scripts/multi-email auth <alias> --browser <default|safari|chrome>
  ```

  The CLI must print the same alias, expected mailbox, provider, browser, scopes, and current health before it opens OAuth. It skips a fully healthy alias by default; use `--force` only when the user explicitly intends to replace that healthy authorization.

Never expose or ask the user to paste the authorization URL, authorization code, token, MSAL cache, or callback secrets.

## Distinguish Google warning from block

These are different outcomes:

- **“Google hasn't verified this app”** with an Advanced/“Go to … (unsafe)” path is an unverified-app warning. It does not identify the target mailbox and does not prove the flow is broken. Never click the unsafe continuation automatically. Pause for the user to inspect the app name, developer/support identity, target browser account, requested access, and decide whether to continue.
- **“This app is blocked”** is a hard block with no usable continuation. Stop blind retries for that alias. Changing Safari to Chrome or vice versa is not a demonstrated fix. Record the alias as blocked and inspect the OAuth app audience/publishing state, test-user membership, requested Gmail scope, Workspace or supervised-account policy, and verification status. Do not blame Advanced Protection or recommend disabling account security without evidence.

If the user declines an unverified warning, also stop and leave that alias unauthorized.

## Diagnose the same alias after completion

Immediately after the user completes the browser flow, run:

```bash
node ./scripts/multi-email doctor <alias> --json
```

Only move to the next alias when the exact same alias reports:

```text
credential_present=true
token_valid=true
identity_verified=true
scopes_valid=true
status=ok
```

If the selected browser identity differs from the expected email, stop with `identity_mismatch`; never reuse that credential for another alias.

## Route failures by layer

| Observation | Meaning | Next action |
| --- | --- | --- |
| `status=ok` and all four checks true | Connected and verified | Skip authorization |
| `MICROSOFT_CLIENT_NOT_CONFIGURED` | Provider-level Entra application/client ID is missing | Configure the client first with `set-microsoft-client`; do not start mailbox OAuth |
| `GOOGLE_CLIENT_NOT_CONFIGURED` | Provider-level Google Desktop client is missing | Initialize the Google Desktop client first; do not start mailbox OAuth |
| `not_authorized` or `credential_present=false` | This alias has no saved mailbox credential | Authorize only this alias |
| `invalid_credential` or `reauthorization_required` | A saved credential cannot be used | Reauthorize only this alias, then rerun its doctor |
| `GOOGLE_OAUTH_CLIENT_MISMATCH` | The saved Google token belongs to a different Desktop client than the current config | Reauthorize this Google alias with `--force`, then rerun its doctor |
| `insufficient_scopes` | Token exists but required mail permission is absent | Reauthorize only after confirming the app requests the intended scopes |
| `identity_mismatch` | Browser/provider identity does not match configured email | Stop and correct account selection or alias configuration |
| `runtime_error`, module/chunk/load error, or MCP startup failure | Installed runtime did not complete | Follow [install-runtime.md](install-runtime.md); do not classify it as missing OAuth |
| `provider_unavailable` | Provider/network diagnosis did not complete | Retry `doctor` later; do not open OAuth based only on this result |
| `provider_policy_blocked` | Provider policy rejected the application/account | Stop browser-switch retries and inspect provider policy/configuration |
| `KEYCHAIN_WRITE_FAILED` during authorization | New credential commit failed and rollback completed | Run `doctor` for the same alias before deciding whether to try again |
| `CREDENTIAL_ROLLBACK_FAILED` | Final Keychain state could not be verified | Stop OAuth retries and inspect that alias's local credential state |

Microsoft client configuration and a Microsoft mailbox token are separate layers. `MICROSOFT_CLIENT_NOT_CONFIGURED` requires an Entra application client ID; `not_authorized` requires per-alias user authorization. One cannot substitute for the other.

## Finish with an honest status table

Report every configured alias as `connected`, `already healthy`, `blocked`, or `not attempted`, with its provider and reason. Do not claim full account coverage when any alias failed, was blocked, or was never configured.
