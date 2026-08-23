# Configure Microsoft Entra for Microsoft 365 mail

Multi Email uses a Microsoft Entra **public client** application that you own. Do not create or
store a client secret for this desktop flow.

Use Microsoft's current documentation as the authoritative UI reference:

- [Register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
- [Configure redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)
- [Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)

## 1. Register the application

1. In Microsoft Entra admin center, open **Entra ID > App registrations**.
2. Select **New registration**.
3. Choose the supported account type that matches the intended mailboxes. Use a tenant-specific
   application for one organization; use an appropriate multi-tenant/personal-account option only
   when that broader audience is intentional.
4. Record the **Application (client) ID**. Do not create a client secret.
5. Under **Authentication**, select **Add a platform > Mobile and desktop applications** and add
   `http://localhost` as a redirect URI. Multi Email's pinned MSAL Node flow binds a random local
   loopback port under that registered localhost redirect.
6. Leave **Allow public client flows** at its default **No** for Multi Email. The registered
   mobile/desktop redirect identifies this authorization-code-with-PKCE request as a public client.
   That fallback toggle is for flows without a redirect URI, such as device code or password grant;
   Multi Email uses neither. Microsoft's
   [client-type troubleshooting reference](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/confidential-client-application-authentication-error-aadsts7000218)
   explains this redirect-based classification.

## 2. Configure delegated permissions

Under **API permissions**, configure delegated Microsoft Graph permissions:

- `User.Read`
- `Mail.ReadWrite`
- `Mail.Send`

`Mail.ReadWrite` does not include sending; `Mail.Send` is a separate delegated permission. These
are write-capable permissions. Tenant policy may require administrator consent.

Do not configure application permissions or client-credential access for Multi Email. The plugin
is designed for an interactive user-delegated identity and verifies the returned `/me` profile
against the configured mailbox.

## 3. Initialize and add an alias

From a reviewed Multi Email Git checkout:

```bash
node ./scripts/multi-email init \
  --microsoft-client-id 00000000-0000-4000-8000-000000000000 \
  --microsoft-tenant organizations

node ./scripts/multi-email add-account m365-main you@example.com microsoft
node ./scripts/multi-email auth m365-main --browser chrome
node ./scripts/multi-email doctor m365-main
```

Replace the example GUID and address with the application and primary mailbox you control. Tenant
may be `organizations`, `common`, `consumers`, a verified tenant domain, or a tenant GUID when that
choice matches the app registration.

Use `default`, `safari`, or `chrome` for the browser value. Before opening OAuth, the CLI displays
the exact alias, expected mailbox, provider, browser, scopes, and existing health. It skips a fully
healthy alias unless `--force` is intentionally supplied. The `/me` identity and required scopes
must match and the Keychain cache write must be read back before the CLI reports success; run
`doctor` for the same alias afterward.

## Common blockers

- **Admin approval required:** ask the tenant administrator to review the exact delegated
  permissions and consent policy. Do not switch to application permissions as a workaround.
- **Identity mismatch:** confirm the primary `mail` or `userPrincipalName` returned by `/me` matches
  the configured address. Shared mailboxes, proxy addresses, and delegated send-as identities are
  not supported by the current primary-mailbox model.
- **Reauthorization required:** from the reviewed clone of the same release, rerun
  `node ./scripts/multi-email auth <alias> --browser <default|safari|chrome>`, then
  `node ./scripts/multi-email doctor <alias>`. Do not paste the MSAL cache or tokens into chat. A
  marketplace install alone does not place the setup CLI on `PATH`.
- **Runtime or module error after restart:** run `node ./scripts/multi-email self-test --json` and
  repair the installed bundle. Do not replace a mailbox credential until its own doctor result
  explicitly requires reauthorization.
- **Wrong tenant:** verify that the configured tenant and the app's supported account types cover
  the selected user.

`doctor` is read-only: it may perform silent token acquisition and call `/me`, but it does not read
messages or rewrite the cached credential.
