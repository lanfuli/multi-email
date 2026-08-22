# Changelog

All notable changes to Multi Email are documented here. The project follows semantic versioning after its first public release.

## [0.1.1] - 2026-08-22

Security hardening release. The npm package remains unpublished in this release.

### Security

- Replaced the simple draft fingerprint with an effective-send manifest that binds the authenticated principal, mailbox, effective From/Sender/Reply-To, recipients, subject, complete plain-text body, threading identity, provider revision, and the absence of attachments.
- Gmail review now binds the decoded raw MIME payload hash and rejects HTML, multipart, inline, attached, nested, unknown, or non-primary-identity drafts. Its send request carries a reconstructed raw message containing only the approved allowlisted fields, closing the final mutable-draft race.
- Microsoft review now binds `changeKey` and `lastModifiedDateTime`, requires complete structured fields and default priority/receipt semantics, verifies the primary identity, and rejects HTML, attachments, incomplete pagination, and unsupported reply identities.
- Microsoft sends a reconstructed approved MIME payload through one `sendMail` request instead of Graph's unconditional existing-draft send action; the original source draft is intentionally retained and reported.
- Provider preflight failures are distinguished from an ambiguous outcome after a send request, and no send is automatically retried.
- Search, mutation, recipient, label-change, and approval-TTL limits now have domain-level hard ceilings that configuration cannot expand.
- The committed bundle now carries deterministic source and artifact digests, and CI checks it before and after rebuilding.
- Added adversarial tests for identity, HTML/MIME, attachment, revision, frozen-payload races, partial provider responses, and oversized-safety configuration changes.

## [0.1.0] - 2026-08-22

Initial public GitHub release. The npm package remains unpublished in this release.

### Added

- Explicit alias routing across Gmail and Microsoft 365.
- Search, message read, plain-text drafts and replies, archive, read state, Gmail labels, and Microsoft categories.
- Read-only account diagnosis across credential presence, token usability, granted scopes, and verified identity without reading message content.
- Server-enforced localhost full-message review before sending, with short-lived one-use approval requests bound to the exact draft.
- macOS Keychain credential storage and mode-restricted routing configuration.
- Codex plugin, skill, and repo-root marketplace manifests.
- `@vercel/ncc` release bundle containing the MCP server, setup CLI, dependencies, and macOS arm64/x64 Keychain native assets.
- MIT license, security/privacy documentation, contributing guide, code of conduct, CI, secret scan, release validation, and cold-install checks.

### Security

- Email content is explicitly treated as untrusted data.
- Send requests cannot be approved through an MCP tool and are never automatically retried after an ambiguous provider result.
- Package and plugin metadata identify Vincent_Lan / `lanfuli` as publisher source; users must still verify the actual Git tag, GitHub owner, and any future npm owner before installation.
