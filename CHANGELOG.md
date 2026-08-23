# Changelog

All notable changes to Multi Email are documented here. The project follows semantic versioning after its first public release.

## [0.1.4] - 2026-08-22

Plugin branding release. The npm package remains unpublished in this release.

### Added

- Added a production Multi Email icon whose three distinct account routes converge into one mail hub, with transparent corners and legibility verified at 32 and 64 pixels.
- Connected the icon to the Codex composer and plugin details through `composerIcon` and `logo` interface metadata, with a matching navy brand color.

### Changed

- Included plugin assets in the npm package whitelist and added release and cold-install checks that fail if the icon is absent from the published archive.
- Displayed the same canonical icon in the GitHub README so the repository and installed plugin share one visual identity.

## [0.1.3] - 2026-08-22

Provider reliability and guided-onboarding release. The npm package remains unpublished in this release.

### Added

- Added a non-interactive, read-only `setup` preflight plus human-readable `doctor` output and stable allowlisted JSON Lines for automation.
- Added provider-owned Google Cloud and Microsoft Entra setup guides with exact scopes, desktop application settings, safe commands, and common policy blockers.
- Added explicit Microsoft partial-batch receipts that identify completed work, the current failed or unknown-outcome item, and untouched remaining IDs.

### Fixed

- Added one 108-second MCP handler budget, enforced a shorter request signal from the remaining budget on provider HTTP calls, disabled hidden Google API mutation retries and provider redirects, and preserved definite preflight failures versus ambiguous post-send outcomes. Uncancellable SDK promises are abandoned by the handler at the deadline and may settle later.
- Capped Gmail transport responses and stream-limited Microsoft identity, Graph JSON, Graph error, and MIME bodies before full buffering or parsing; oversized responses are actively abandoned.
- Removed absolute configuration paths, provider-controlled diagnostic codes, provider identifiers, and untrusted provider text from setup, MCP diagnostic, and unknown-send log output while retaining actionable allowlisted status codes.

### Security

- A send request remains single-attempt: timeout or disconnect after submission produces an unknown result and cannot silently reuse approval.
- Gmail, Microsoft identity, and Graph transports reject redirects so a 307/308 cannot replay a mutation or token POST body.
- A timed-out, HTTP 408, or HTTP 5xx Microsoft batch mutation no longer claims the in-flight item definitely failed, preventing an unsafe replay based on a false receipt.

## [0.1.2] - 2026-08-22

Installation, onboarding, and local hardening release. The npm package remains unpublished in this release.

### Fixed

- Added first-class Microsoft-only initialization, strict Microsoft application-ID and tenant validation, a narrow repair path for invalid values accepted by v0.1.1, provider-readiness checks before adding an account, truthful preserved-provider status, and CLI version output.
- Replaced package-consumer-incompatible `npm run setup` guidance with the installed `multi-email` command and the matching Git-clone fallback.
- Pinned Git marketplace instructions to the annotated release tag and replaced the ineffective shallow-tag `git pull` upgrade path with explicit tag fetch and checkout instructions.
- Included the contributing guide and code of conduct in the npm tarball so README links remain valid for package consumers.

### Security

- Hardened config persistence with exclusive randomized temporary files, no-follow semantics, fsync before atomic replacement, symlink and non-regular target rejection, and preservation of permissions on existing parent directories.
- Removed absolute config paths from invalid-JSON errors and unified packaged CLI error redaction so unknown provider or parser exceptions cannot expose request context.
- Canonicalized mailbox addresses with strict single-mailbox validation and fail-closed provider-draft parsing to reject control characters, group syntax, and semantic address ambiguity.
- Bounded approval-request and browser-session retention, swept expired state, and immediately discarded requests when the local approval UI cannot open.
- Used the absolute macOS `/usr/bin/open` path for the local approval window.

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
