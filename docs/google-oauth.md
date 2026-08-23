# Configure Google OAuth for Gmail

Multi Email uses a Google **Desktop app** OAuth client that you own. It does not provide a shared
Google client, and it never asks you to paste an authorization URL, code, access token, or refresh
token into Codex or a GitHub issue.

Google's current Gmail Node.js quickstart is the authoritative UI reference:
[Node.js quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs).

## 1. Create or select a Google Cloud project

Use a project you control. Keep development/testing and production OAuth apps separate when the
accounts or policies require that separation.

In Google Cloud Console:

1. Select the intended project.
2. Open **APIs & Services** and enable **Gmail API**.
3. Open **Google Auth platform** and configure Branding, Audience, and Data Access.
4. Choose the audience that matches the accounts you will authorize. For an External app in
   Testing, add every intended mailbox owner as a test user.
5. Declare only the scopes Multi Email currently requests: `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.modify`.

`gmail.modify` permits reading, composing, sending, and organizing Gmail. It is not a read-only
permission. Google may require verification or apply organization/account policy even when you
bring your own client. See Google's current
[Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## 2. Create the Desktop client

1. Open **Google Auth platform > Clients**.
2. Select **Create client**.
3. Choose **Desktop app**. Do not choose Web application.
4. Download the client JSON to a private local path.

The JSON contains OAuth application credentials. Do not commit it, attach it to an issue, or paste
it into Codex. Multi Email copies the required settings into its mode-`0600` local configuration;
mailbox tokens are stored separately in macOS Keychain.

## 3. Initialize and add an alias

From a reviewed Multi Email Git checkout:

```bash
node ./scripts/multi-email init \
  --google-client-json /absolute/private/path/to/desktop-client.json

node ./scripts/multi-email add-account gmail-main you@example.com google
node ./scripts/multi-email auth gmail-main
node ./scripts/multi-email doctor gmail-main
```

The browser identity returned by Google must exactly match the configured mailbox. Authorize each
alias independently.

## Common blockers

- **This app is blocked:** stop repeated retries. Check the requested Gmail scope, OAuth app
  audience/publishing state, test-user membership, Workspace or supervised-account policy, and
  verification status.
- **Token expires or becomes invalid:** from the reviewed clone of the same release, run
  `node ./scripts/multi-email auth <alias>` again, then
  `node ./scripts/multi-email doctor <alias>`. Do not delete Keychain entries merely to diagnose
  the connection. A marketplace install alone does not place the setup CLI on `PATH`.
- **Identity mismatch:** confirm the exact configured email and browser account. Do not reuse the
  token for another alias.
- **Testing app behavior:** External apps in Testing can have test-user and token-lifetime limits.
  Moving to Production is not the same as completing Google verification.

`doctor` is read-only: it may contact Google to check token, scope, and identity health, but it does
not read messages or migrate credentials.
