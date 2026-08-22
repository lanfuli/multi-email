# Changelog

All notable changes to Multi Email are documented here. The project follows semantic versioning after its first public release.

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
