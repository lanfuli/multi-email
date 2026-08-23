# Configure Google OAuth for Gmail

Multi Email is a Developer Preview that uses a Google **Desktop app** OAuth client that you own. The
release package does not include a shared Google client or a maintainer-owned authorization
fallback, and it never asks you to paste an authorization URL, code, access token, or refresh token
into Codex or a GitHub issue. This is a bring-your-own-OAuth workflow, not a one-click connection or
a way around Google policy.

Google's current Gmail Node.js quickstart is the authoritative UI reference:
[Node.js quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs).

## Recommended guided setup (optional)

The separate [Computer Use Codex plugin](https://learn.chatgpt.com/docs/computer-use) can guide these
Cloud Console pages in the user's browser. It is optional and is not a Multi Email dependency.
Install and enable it from Codex Plugins, turn on its server and skill toggles, and grant the
documented macOS Screen Recording and Accessibility permissions, or continue with the manual steps
below when it is unavailable or browser control is not desired.

For the Google Auth Platform Desktop client used here, Google's supported setup is the Cloud Console
rather than an API. IAM/IAP OAuth-client APIs are a different product surface and do not create this
Gmail Desktop client. See Google's
[OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).
Computer Use may navigate and explain the form, but the user handles Google sign-in, MFA or passkeys
and every Gmail consent or warning decision. Immediately before **Create**, Computer Use must request
an action-time confirmation because that click generates persistent credentials, then hand over the
browser. The user personally clicks Create, downloads the JSON, closes the dialog, and provides only
the downloaded file's local path. Computer Use must not inspect that dialog or read, transcribe,
copy, or echo the client ID, client secret, or JSON contents. It must
not silently choose a publishing status, submit verification or legal declarations, or weaken
account or organization policy. For an External app, it must explain that Testing makes these Gmail
refresh tokens expire after seven days, while In production removes that Testing lifecycle but is
not the same as verification and may still show warnings or encounter policy blocks.

Use this onboarding prompt:

> Use $multi-email to set up my user-owned Google Cloud Desktop OAuth client, using Computer Use if
> available, then connect my requested Gmail aliases one at a time. Follow the assisted onboarding
> confirmation and credential-handling safeguards.

## 1. Create or select a Google Cloud project

Use a project you control. Keep development/testing and production OAuth apps separate when the
accounts or policies require that separation.

If no suitable project exists, confirm the new project name, project ID, and organization/folder
parent before creating it. Do not attach billing, change IAM, or reuse an unrelated production
project as part of this onboarding. Stop if Google unexpectedly requires billing or administrator
action.

In Google Cloud Console:

1. Select the intended project.
2. Open **APIs & Services** and enable **Gmail API**.
3. Open **Google Auth platform** and configure Branding, Audience, and Data Access.
4. Choose the audience that matches the accounts you will authorize. For an External app in
   Testing, add every intended mailbox owner as a test user. Google states that these test-user
   authorizations expire seven days after consent when non-basic scopes are requested, including an
   offline refresh token. See [Manage App Audience](https://support.google.com/cloud/answer/15549945?hl=en).
5. Declare only the scopes Multi Email currently requests: `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.modify`.

`gmail.modify` permits reading, composing, sending, and organizing Gmail. It is not a read-only
permission, and Google classifies it as a restricted scope. Google may require verification or
apply organization/account policy even when you bring your own client. Moving an External app to
Production changes the Testing lifecycle but does not make it verified or guarantee that every
account can authorize. See Google's current
[Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

Before adding `gmail.modify` or starting mailbox consent, confirm that the user accepts this access.
Multi Email has no reduced-scope or read-only Google mode.

## 2. Create the Desktop client

1. Open **Google Auth platform > Clients**.
2. Select **Create client**.
3. Choose **Desktop app**. Do not choose Web application.
4. Review the project, type, and name, then select the final **Create** action. During assisted
   setup, Computer Use stops here and the user takes over.
5. Download the client JSON to a private local path and close the credential dialog before returning
   control.

The JSON contains OAuth application credentials. Keep it on the local Mac: do not upload it, commit
it, attach it to an issue, paste its contents or client secret into Codex, or expose it through a
screen share. Multi Email reads the file from its local path and copies the client ID and client
secret into its mode-`0600` local configuration; mailbox tokens are stored separately in macOS
Keychain. The CLI does not delete the downloaded source JSON. After initialization and successful
per-alias diagnosis, move it to an owner-only private location or delete it yourself if you no longer
want the extra copy; Multi Email never does that automatically.

## 3. Initialize and add an alias

One Multi Email config contains one Google client. All Google aliases in that config use the same
client, but each alias receives and stores its own mailbox authorization. The release does not select
or create a Google Cloud project through its MCP or CLI; the optional Computer Use workflow only
guides the user-controlled Console UI under the confirmation boundaries above.

From a reviewed Multi Email Git checkout:

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/private/path/to/desktop-client.json

node ./scripts/multi-email add-account gmail-main you@example.com google
node ./scripts/multi-email auth gmail-main --browser safari
node ./scripts/multi-email doctor gmail-main
```

Use `default`, `safari`, or `chrome` for the browser value. Before the browser opens, the CLI shows
the exact alias, expected mailbox, provider, browser, requested scopes, and existing health. A
fully healthy alias is skipped unless `--force` is intentionally supplied.

The desktop flow uses PKCE and explicit account selection. The browser identity returned by Google
must exactly match the configured mailbox, token info must belong to the configured Google client
and contain the required scopes, and the Keychain write must be verified before success is shown.
Authorize each alias independently, then run `doctor` for that same alias. A browser callback by
itself is not completion.

## Replace an existing Google client

Replacing the configured Google client affects every Google alias in the config. Plan a maintenance
window: updating the provider setting and reauthorizing all aliases is not one atomic transaction.

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/private/path/to/replacement-desktop-client.json \
  --confirm
```

The first setup and a repeated import of the same client do not require `--confirm`; a different
client ID does. Do not first run `logout`, `revoke`, delete Keychain items, or remove aliases. After
the client changes, process every Google alias separately:

```bash
node ./scripts/multi-email auth <google-alias> --browser <default|safari|chrome> --force
node ./scripts/multi-email doctor <google-alias> --json
```

Move to the next alias only after the current one reports `status=ok` and all credential, token,
scope, and identity checks are true. A partial migration can contain credentials issued to both the
old and new clients. There is no automatic whole-config rollback; if you stop or restore the old
client, diagnose every alias again before using mail tools.

The old application's grant can remain in each Google account after local migration. Once every
alias is healthy on the new client, you may separately remove the old app from Google's account
access settings. Confirm the old app identity before doing so. Do not use Multi Email `revoke` for
this cleanup after migration, because it targets the current credential rather than the old grant.

## Common blockers

- **Developer or support email looks unfamiliar:** it identifies the OAuth application and Cloud
  project, not the target Gmail account. Confirm the selected browser identity against the expected
  mailbox printed by the CLI.
- **Google hasn't verified this app:** if Google offers an Advanced continuation, this is an app
  trust warning. Multi Email does not click it. Inspect the app owner, target account, and requested
  access, then make the decision yourself.
- **This app is blocked:** this is a hard policy result; stop repeated retries and do not switch
  browsers as a workaround. Check the requested Gmail scope, OAuth app
  audience/publishing state, test-user membership, Workspace or supervised-account policy, and
  verification status.
- **Token expires or becomes invalid:** from the reviewed clone of the same release, run
  `doctor` first. Only when that alias explicitly requires reauthorization, run
  `node ./scripts/multi-email auth <alias> --browser <default|safari|chrome>` again, then
  `node ./scripts/multi-email doctor <alias>`. Do not delete Keychain entries merely to diagnose
  the connection. A marketplace install alone does not place the setup CLI on `PATH`.
- **Runtime or module error after restart:** run `node ./scripts/multi-email self-test --json` and
  repair the installed bundle. Runtime failure is not evidence that a refresh token expired.
- **Identity mismatch:** confirm the exact configured email and browser account. Do not reuse the
  token for another alias.
- **Testing app behavior:** External test-user authorizations for these scopes expire after seven
  days, including offline refresh tokens. Moving to Production is not the same as completing Google
  verification, and it does not override account or organization policy.

`doctor` is read-only: it may contact Google to check token, scope, and identity health, but it does
not read messages or migrate credentials.
