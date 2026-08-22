# Contributing

Thank you for helping make Multi Email safer and easier to use.

## Development setup

Requirements are macOS and Node.js 22 or newer.

```bash
git clone https://github.com/lanfuli/multi-email.git
cd multi-email
npm ci
npm run validate
npm run pack:check
```

Do not use a real mailbox, OAuth client, token, authorization URL, or production config in tests, fixtures, screenshots, issues, or pull requests. Keep test provider calls mocked unless a separately documented and isolated integration environment is explicitly approved.

## Pull requests

- Keep changes focused and explain the user-visible behavior and security impact.
- Add or update tests for meaningful behavior, especially account routing, identity binding, provider URL constraints, write bounds, and send approval.
- Preserve explicit `account_alias` routing; never add an implicit default mailbox.
- Treat all email and attachment content as untrusted data.
- Do not add permanent deletion or automatic send retries.
- Mutations require explicit user intent. Sending must remain blocked until the exact draft is approved through the server-owned localhost review surface.
- Never expose an MCP tool that can approve its own send request.
- Avoid returning OAuth URLs, codes, tokens, cookies, nonces, client secrets, or complete Keychain errors through MCP.
- Update README, security/privacy documentation, skill instructions, manifest metadata, and changelog when behavior changes.

Run before opening a pull request:

```bash
npm run validate
npm run pack:check
npm audit --omit=dev --audit-level=high
python3 /path/to/skill-creator/scripts/quick_validate.py ./skills/multi-email
python3 /path/to/plugin-creator/scripts/validate_plugin.py .
```

The final two validators are supplied by a Codex development installation and are not npm dependencies.

## Generated release bundle

`dist/` is committed because Codex Git marketplace snapshots do not contain `node_modules/`. After source or dependency changes, run:

```bash
npm run build
```

Commit the resulting `dist/server.cjs`, chunks, license inventory, build manifest, and both Keychain native assets. Do not hand-edit generated bundle files.

## Dependencies

Use exact versions and update `package-lock.json`. Explain why a new dependency is needed, review its license and install scripts, run the audit and cold-install checks, and include generated bundle changes. Avoid dependencies for functionality that can be implemented clearly with Node.js built-ins.

## Releases

Maintainers should:

1. confirm a clean, reviewed Git tree and full-history secret scan;
2. run all validation and cold-install checks on macOS arm64 and x64;
3. update `CHANGELOG.md` and version fields together;
4. inspect `npm pack --dry-run --json` and `npm publish --dry-run`;
5. create a signed/tagged GitHub release before announcing availability;
6. publish npm only through an authenticated, explicitly approved maintainer action;
7. verify the installed Git marketplace snapshot and start a fresh Codex task.

## Conduct and security

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue containing sensitive details.
