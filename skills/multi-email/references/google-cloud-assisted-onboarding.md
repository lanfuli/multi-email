# Assisted Google Cloud onboarding

Use this workflow when a user wants help creating the user-owned Google Desktop OAuth client that
Multi Email requires. It configures the provider application first; mailbox authorization remains a
separate, per-alias step.

## Choose assisted or manual setup

Computer Use is optional and comes from a separate plugin. Use it only when its skill and UI tools
are already available. If they are unavailable, the Console cannot be inspected reliably, or the
user prefers to drive the browser, stop UI automation and follow the repository's
[manual Google OAuth guide](../../../docs/google-oauth.md). Do not present Computer Use as bundled
with Multi Email or required for connecting accounts.

Before opening Google Cloud, run the matching checkout's local, read-only preflight:

```bash
node ./scripts/multi-email setup
```

This must not read Keychain, contact Google, or alter configuration. If Google OAuth is already
configured, establish whether the user intends to keep it or replace it; never replace a healthy
client merely to verify setup.

## Confirm the audience first

Ask the user to confirm the intended OAuth audience before changing the Console:

- **Internal** applies only when an eligible Google Workspace organization owns the project and all
  intended accounts are inside that organization.
- **External** is required for consumer Gmail, accounts outside the organization, or accounts across
  unrelated domains. While the app is in Testing, add every intended mailbox's real Google account
  email address as a test user; a local Multi Email alias is not a Google identity.

Do not choose the audience from whichever account happens to be signed into the browser. For an
External app, also make the publishing-status tradeoff explicit before continuing: Testing limits
authorization to listed test users and makes these Gmail refresh tokens expire seven days after
consent; In production removes that Testing lifecycle but can still show an unverified-app warning,
remain subject to the new-user cap, and require verification or organization approval. Do not treat
In production as verified or select a publishing status silently. If the user asks for a durable
External connection, stop at the Publish app action and obtain an action-time confirmation before
changing status. Never start verification or submit policy/compliance claims automatically.

## Assist in Google Cloud Console

Google OAuth clients for this workflow must be created in a user-controlled project through Google
Cloud Console. Do not attempt to create one through an undocumented API, `gcloud`, or generated
JSON.

If the user has no suitable project, confirm the new project's display name, generated or chosen
project ID, and organization/folder parent before creating it. Stop immediately before **Create
project** for the user's confirmation. Do not attach a billing account, change IAM, or reuse an
unrelated production project merely to enable Gmail API. If Google unexpectedly requires billing or
an organization administrator, stop and report that boundary instead of expanding the setup.

With Computer Use, help the user navigate and inspect the Console while keeping these boundaries:

1. Confirm the intended project and enable Gmail API if it is not enabled.
2. Configure Google Auth Platform Branding and the already-confirmed Internal or External audience.
3. In Data Access, request only `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.modify`. Make clear that `gmail.modify` permits reading,
   composing, sending, and organizing Gmail; it is not read-only. Before adding this restricted
   scope or starting mailbox consent, ask the user to confirm that they accept that access. Multi
   Email has no reduced-scope or read-only Google mode; stop if they do not accept it.
4. For External Testing, add each intended mailbox's real Google account email address as a test
   user, never its local Multi Email alias.
5. Under Clients, choose **Desktop app**, never Web application, and enter the user-approved name.

Hand login, account selection, passwords, passkeys, Touch ID, MFA, verification codes, CAPTCHA, and
Google consent decisions to the user. Never bypass an unverified-app or browser security warning.
Refresh the UI state after each assisted action and stop if the observed project, audience, scopes,
or account differs from what the user confirmed.

If Google presents Terms of Service, a legal attestation, or a policy declaration, stop for the user
to review it and obtain the required action-time confirmation. Never infer acceptance from the
general setup request or accept legal language on the user's behalf without that confirmation.

The final **Create OAuth client** action generates persistent credentials. Stop immediately before
it, explain which project, audience, scopes, and Desktop client name will be committed, request the
Computer Use action-time confirmation, and hand over the browser. The user must personally click
Create, download the JSON, and close every dialog that displays credentials. Computer Use must not
inspect or capture the resulting credential dialog, transcribe or echo the client ID or secret, or
read/paste the JSON into the conversation. Resume only after the dialog is closed and the user
supplies the downloaded file's absolute local path.

## Import locally, then authorize one alias at a time

For a new Google provider configuration, import the downloaded Desktop JSON locally:

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/private/path/to/desktop-client.json
```

The path is passed directly to the local CLI; never print the file contents. If a Google client is
already configured, replacement affects every Google alias and is not a whole-config atomic
migration. Review that impact, then use the guarded form only when the user intends the replacement:

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/private/path/to/desktop-client.json \
  --confirm
```

Do not run `logout`, `revoke`, delete Keychain credentials, or remove aliases before replacement.
Follow [oauth-onboarding.md](oauth-onboarding.md) for its maintenance-window and failure rules.

The import stores the Desktop client ID and client secret in Multi Email's mode-`0600` local config;
mailbox tokens remain in macOS Keychain. It does not remove the downloaded source JSON. After the
import and per-alias diagnosis succeed, tell the user that the original file remains and let them
choose whether to move it to an owner-only private location or delete it. Never delete or relocate it
automatically.

Add and verify each new alias independently:

```bash
node ./scripts/multi-email add-account <alias> <email> google
node ./scripts/multi-email auth <alias> --browser <default|safari|chrome>
node ./scripts/multi-email doctor <alias> --json
```

For every alias affected by a client replacement, use `auth <alias> --force`, then run its `doctor`.
The CLI may open the OAuth page, but the user handles its account picker and consent screen. Move to
the next alias only when the same alias reports `credential_present`, `token_valid`,
`identity_verified`, and `scopes_valid` as true with `status=ok`.

Replacing the local client does not remove the old application's grant from each Google account.
Only after every alias is healthy on the new client, offer a separate user-approved cleanup of the
old app in Google's account-access settings. Do not run Multi Email `revoke` for that cleanup: after
migration it targets the current credential, not the old client grant.
