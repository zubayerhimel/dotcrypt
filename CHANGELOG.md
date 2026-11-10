# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `status` command: shows, per environment, whether you or your team changed something since your
  last sync and what to do next. No password needed.
- Sync tracking: fingerprints recorded in `.git/dotcrypt/sync-state.json` (per clone, never
  committed) so dotcrypt can tell local changes from incoming ones.
- `encrypt` now prints the Git command to send the `.enc` file to your team.

### Changed

- Simpler dashboard: plain-language states ("You have unshared changes", "New changes from your
  team", ...), one main button per environment, a copyable commit/push command, a "How sharing
  works" guide, and a Compare dialog to choose between your version and your team's.

### Fixed

- The dashboard no longer reports "Local changed" right after decrypting.

## [1.0.0] - 2026-11-10

### Added

- `init`, `encrypt`, `decrypt`, `rotate-key` and `diff` commands for AES-256-GCM (scrypt) encrypted
  `.env` files that are safe to commit to Git.
- `ui` command: a local, token-protected web dashboard bound to `127.0.0.1`.
- Overwrite protection with key-level diffs (values are never printed).
- `encrypt --replace` to deliberately discard a vault file that is unreadable, belongs to another
  environment, or uses a different password.
- Passwords via interactive prompt, `DOTCRYPT_PASSWORD` / `DOTCRYPT_NEW_PASSWORD`, or flags.

[Unreleased]: https://github.com/zubayerhimel/dotcrypt/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/zubayerhimel/dotcrypt/releases/tag/v1.0.0
