# dotcrypt

Keep your `.env` files in sync across machines and teammates **using the Git repository you
already have**. Your plaintext `.env` files stay on your machine; only AES-256-GCM encrypted
`.enc` copies are committed and shared.

```
.dotcrypt.json             <- committed: environments + file mappings (no secrets)
.env.development           <- local only (git-ignored)
.env.development.enc       <- committed: encrypted
.env.production            <- local only (git-ignored)
.env.production.enc        <- committed: encrypted
```

- One password per environment (development, staging, production, ...).
- No server, no account, no extra service: secrets travel through `git push` / `git pull`.
- Works from the terminal or from a local web dashboard (`dotcrypt ui`).

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Everyday use](#everyday-use)
- [Commands](#commands)
- [Passwords](#passwords)
- [CI, Docker and servers](#ci-docker-and-servers)
- [Web dashboard](#web-dashboard)
- [Git hooks](#git-hooks)
- [Configuration (`.dotcrypt.json`)](#configuration-dotcryptjson)
- [Troubleshooting](#troubleshooting)
- [Security](#security)

## Installation

Requires **Node.js 18.17 or newer**.

```bash
npm install -g dotcrypt
dotcrypt --version
```

Or run it without installing:

```bash
npx dotcrypt --help
```

To uninstall: `npm uninstall -g dotcrypt`.

## Quick start

**First person on the project (once):**

```bash
cd path/to/your-project
dotcrypt init                    # creates .dotcrypt.json and updates .gitignore
# create or keep your .env.development, .env.production, ... files as usual
dotcrypt encrypt -e development  # choose a password; writes .env.development.enc
git add .dotcrypt.json .gitignore .env.development.enc
git commit -m "Add encrypted env files" && git push
```

Share the password with your teammates privately (a password manager, not chat or the repo).

**Teammates:**

```bash
git clone <your-repo> && cd <your-repo>
dotcrypt decrypt -e development  # enter the password; writes .env.development
```

Prefer clicking? Run `dotcrypt ui` and follow the cards on the dashboard. Everything in the
dashboard is also available as a CLI command.

## Everyday use

Not sure what to do? Run `dotcrypt status`. It tells you, per environment, what changed and the
next command to run. It never needs a password.

| Status | Meaning | Next step |
| --- | --- | --- |
| Up to date | Nothing changed since your last sync. | Nothing. |
| You have changes your team does not have | Your local `.env` file changed. | `dotcrypt encrypt`, then commit and push the `.enc` file. |
| New changes from your team | The `.enc` file changed (e.g. after `git pull`). | `dotcrypt decrypt`. |
| Changed both locally and by your team | Both changed. | `dotcrypt diff` to see which variables differ, then choose a side. |
| Not shared yet | You have a local file but no `.enc` file. | `dotcrypt encrypt`. |
| Shared by your team, not on this machine yet | There is an `.enc` file but no local file. | `dotcrypt decrypt`. |
| Not checked yet on this machine | First run on this clone. | `dotcrypt diff` once with the password. |

`status` prints the exact command for each step.

**You added or changed a variable**

```bash
# edit .env.development in your editor, then:
dotcrypt encrypt -e development
git add .env.development.enc && git commit -m "Update development secrets" && git push
```

Or change a single variable without opening the file:

```bash
dotcrypt set API_URL=https://api.example.com -e development
dotcrypt set STRIPE_KEY -e production     # asks for the value at a hidden prompt
dotcrypt unset OLD_FLAG -e development
```

`set` and `unset` update both the `.enc` file and your local file. Commit and push the `.enc`
file afterwards.

**A teammate changed something**

```bash
git pull
dotcrypt decrypt -e development
```

**Both of you changed the same environment**

1. `dotcrypt diff -e <env>` shows which variable names were added, removed or changed (values are
   never printed).
2. Keep yours: copy anything you need from the team version into your file, then
   `dotcrypt encrypt -e <env>`.
3. Or take the team's: `dotcrypt decrypt -e <env>` (you are asked before anything is overwritten).

**Find variables missing in some environments**

```bash
dotcrypt check                      # compares all environments
dotcrypt check -e staging,production
```

Lists variable names that exist in one environment but not another. Exits with code 1 if
something is missing, so it can run in CI.

**Someone leaves the team / a password leaked**

```bash
dotcrypt rotate-key -e production
git commit -am "Rotate production vault password" && git push
```

> ⚠️ Rotating the password does **not** revoke secrets. Anyone with the old password can still
> decrypt old versions of the `.enc` file from Git history. After a departure or leak, also
> rotate the **underlying secrets** (API keys, database passwords), then `dotcrypt encrypt`
> again.

**Merge conflicts in `.enc` files**

Encrypted files can't be merged line by line. Take one side
(`git checkout --theirs .env.production.enc`), run `dotcrypt decrypt`, re-apply your changes to
the `.env` file, then run `dotcrypt encrypt`.

## Commands

| Command | Description |
| --- | --- |
| `dotcrypt status` | Show what changed in each environment and what to do next. No password needed. |
| `dotcrypt init` | Create `.dotcrypt.json` and add ignore rules for plaintext env files to `.gitignore`. |
| `dotcrypt encrypt` | Encrypt your local env file (e.g. `.env.staging`) into its `.enc` file. |
| `dotcrypt decrypt` | Decrypt the `.enc` file into your local env file. |
| `dotcrypt diff` | Show which variable **names** were added, removed or changed. Values are never printed. |
| `dotcrypt set <KEY=value \| KEY>...` | Set variables in the `.enc` file and your local file. A bare `KEY` asks for a hidden value (or reads stdin). |
| `dotcrypt get <KEY>` | Print one variable from the `.enc` file. Exits 1 if it is not set. |
| `dotcrypt unset <KEY>...` | Remove variables from the `.enc` file and your local file. |
| `dotcrypt run -- <command>` | Run a command with the decrypted variables set. Nothing is written to disk. |
| `dotcrypt check` | List variables that exist in one environment but are missing in another. |
| `dotcrypt rotate-key` | Re-encrypt with a new password. |
| `dotcrypt hooks install` / `uninstall` | Add or remove Git hooks (see [Git hooks](#git-hooks)). |
| `dotcrypt ui` | Open the local web dashboard. |

Run `dotcrypt <command> --help` for all options and examples.

### Options

| Option | Commands | Description |
| --- | --- | --- |
| `-e, --env <name>` | most commands | Environment to use. If omitted you are asked to pick one (non-interactive runs use the default environment). For `check`, a comma-separated list. |
| `-p, --password <password>` | encrypt, decrypt, diff, set, get, unset, run, check | Password. Prefer a prompt or `DOTCRYPT_PASSWORD` (see [Passwords](#passwords)). |
| `-f, --force` | init, encrypt, decrypt | Overwrite without asking. |
| `--replace` | encrypt | Replace an `.enc` file that can't be opened with this password (see below). |
| `-o, --old-password` / `-n, --new-password` | rotate-key | Current and new password. |
| `--exit-code` | diff | Exit with 1 when differences are found. |
| `--override` | run | Let values from the `.enc` file replace variables already set in your shell. |
| `-q, --quiet` | run | Don't print the summary of injected variables. |
| `-n, --name`, `--envs a,b,c`, `-d, --default-env`, `-y, --yes` | init | Project name, environment list, default environment, accept defaults. |
| `--port <n>`, `--no-open` | ui | Fixed port; don't open the browser. |

### Safety prompts

dotcrypt asks before it overwrites anything:

- `decrypt` shows which variables would be lost or changed in your local file and asks first.
- `encrypt` shows what will change in the `.enc` file and asks first. If nothing changed, nothing
  is written (no Git noise).
- `encrypt` checks your password against the existing `.enc` file, so nobody accidentally
  re-encrypts a shared file with a different password. Use `rotate-key` to change passwords. Only
  `--replace` discards an `.enc` file that can't be opened (`--force` never does).
- `init` won't overwrite an existing `.dotcrypt.json` without confirmation or `--force`.
- In non-interactive sessions (CI, pipes) dotcrypt never prompts; it stops safely unless `--force`
  is given.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error, aborted, or differences / missing variables found (`diff --exit-code`, `check`, `get`) |
| `2` | Wrong password, or the `.enc` file is corrupted or was tampered with |
| `130` | Cancelled at a prompt (Ctrl+C) |

## Passwords

Each environment has its own password. dotcrypt looks for it in this order:

1. **Command-line flag** (`-p`, `-o`, `-n`). Works, but prints a warning: flags end up in shell
   history and process listings.
2. **Environment variable** `DOTCRYPT_PASSWORD` (and `DOTCRYPT_NEW_PASSWORD` for the new password
   in `rotate-key`). Recommended for CI.
3. **Hidden prompt.** Recommended on your own machine.

New passwords must be at least 12 characters and are asked twice. Use long random passphrases from
a password manager, and a different password per environment.

## CI, Docker and servers

Use `run` so the secrets are never written to disk:

```bash
DOTCRYPT_PASSWORD="$VAULT_PASSWORD_PRODUCTION" dotcrypt run -e production -- npm start
```

`run` decrypts in memory, starts your command with the variables set, and passes through its exit
code and signals. Variables already set in the environment win unless you add `--override`.
`DOTCRYPT_PASSWORD` and `DOTCRYPT_NEW_PASSWORD` are removed before your command starts.

If a tool really needs a file: `DOTCRYPT_PASSWORD=... dotcrypt decrypt -e production --force`.

Check in CI that no environment is missing a variable:

```bash
DOTCRYPT_PASSWORD="$VAULT_PASSWORD" dotcrypt check
```

## Web dashboard

```bash
cd path/to/your-project
dotcrypt ui                  # opens your browser on a random free port
dotcrypt ui --port 4600      # fixed port
dotcrypt ui --no-open        # only print the URL
```

The terminal prints a URL like `http://127.0.0.1:53412/?token=3f9c…` and opens it. If the browser
doesn't open, copy the **full** URL (including `?token=`). Keep the terminal open while you use the
dashboard and press **Ctrl+C** to stop it.

The dashboard shows:

- one card per environment with its status in plain words and one button for the next step
  (**Share changes**, **Get latest**, **Review**, ...)
- the exact Git command to share an updated `.enc` file, with a copy button
- Git safety checks: whether plaintext files are ignored or (dangerously) tracked, with a one-click
  fix for missing `.gitignore` rules
- **Missing variables** across environments (names only, never values)
- an activity log for the session

Less common actions (compare, force share or get, change password, make default) are in each
card's **⋯** menu. The dashboard refreshes every few seconds, so changes from the terminal or
`git pull` show up automatically.

The dashboard only listens on `127.0.0.1`, needs the per-run token in the URL, and never sends
secret values to the browser. Each run creates a new token, so old URLs stop working after a
restart. Don't share the printed URL.

## Git hooks

```bash
dotcrypt hooks install
```

Run once per clone (hooks aren't shared through Git). It adds dotcrypt to the `pre-commit`,
`post-merge` and `post-checkout` hooks, keeping any existing hooks and respecting
`core.hooksPath`:

- **Before a commit:** blocks the commit if it includes a plaintext env file such as `.env` or
  `.env.local`, and reminds you about changes you haven't shared yet.
- **After `git pull` or switching branches:** tells you when teammates changed secrets and which
  command gets them.

If dotcrypt isn't installed, the hooks do nothing. `git commit --no-verify` skips the check.
`dotcrypt hooks uninstall` removes them.

Using husky? Add `npx dotcrypt hook pre-commit` to `.husky/pre-commit` and
`npx dotcrypt hook post-merge` to `.husky/post-merge` instead.

## Configuration (`.dotcrypt.json`)

`dotcrypt init` creates this file. Commit it; it contains no secrets.

```json
{
  "version": 1,
  "vault": {
    "name": "my-app",
    "createdAt": "2026-11-07T06:00:00.000Z",
    "cipher": "aes-256-gcm",
    "kdf": "scrypt"
  },
  "defaultEnvironment": "development",
  "environments": {
    "development": { "file": ".env.development", "encryptedFile": ".env.development.enc" },
    "staging":     { "file": ".env.staging",     "encryptedFile": ".env.staging.enc" },
    "production":  { "file": ".env.production",  "encryptedFile": ".env.production.enc" }
  }
}
```

You can edit the mappings by hand, for example `"file": "apps/api/.env"` in a monorepo. Rules:

- Environment names: 1–64 letters, digits, `-` or `_`.
- Paths must be relative and stay inside the project (no absolute paths, no `..`).
- `encryptedFile` must end in `.enc`; `file` must not.
- Two mappings can't use the same path (case-insensitive).

Run `dotcrypt init` again after adding custom paths so they are added to `.gitignore`.

### How dotcrypt knows what changed

`.enc` files are different every time they are encrypted, so dotcrypt can't compare them directly.
Instead, whenever you encrypt, decrypt or diff, it records fingerprints (SHA-256) of both files in
`.git/dotcrypt/sync-state.json`. This file stays in your clone and is never committed. That is
why `status` and the dashboard can show what changed without a password.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Decryption failed: the password is incorrect, or the encrypted file is corrupted…` (exit code 2) | Check you're using the password for **this** environment. A file that was edited or swapped with another environment's `.enc` file also fails. |
| `encrypt` refuses because the password doesn't match the existing `.enc` file | Use the shared password, or `rotate-key` to change it. Only use `--replace` if you really want to discard the existing file. |
| Warning that a plaintext file is tracked by Git | Run `git rm --cached <file>`, commit, and make sure `.gitignore` covers it (`dotcrypt init` adds the rules). Rotate any secrets that were pushed. |
| Dashboard says "Session token missing or expired" | Open the URL printed by the current `dotcrypt ui` run (tokens change on every start). |
| Status shows "Not checked yet on this machine" | Run `dotcrypt diff -e <env>` once with the password. |
| Windows PowerShell: "running scripts is disabled on this system" | Use `npx.cmd dotcrypt ...` / `npm.cmd install -g dotcrypt`, or run from Command Prompt. |

## Security

### What it protects

- Protects secrets **at rest in Git** (your hosting provider, forks, leaked clones) from anyone
  without the password.
- Does **not** protect against a compromised developer machine, or against anyone who has the
  password. Old `.enc` files in Git history stay readable with old passwords.
- It is not a full secrets manager (no per-user access control, audit logs or automatic rotation).
  It is designed for small, trusted teams.

### Encryption

- **AES-256-GCM** (authenticated encryption) from Node's built-in `crypto` module, with a 128-bit
  authentication tag.
- **scrypt** key derivation (`N=2^15, r=8, p=1`, ~32 MiB). Passwords are Unicode-normalized so the
  same password works on every OS and keyboard.
- A **new random salt and IV** on every `encrypt` and `rotate-key`.
- The file header (format version, algorithm, KDF parameters, salt, IV, environment name, source
  file, timestamp) is **authenticated** together with the ciphertext. Editing it, or copying
  `staging.enc` over `production.enc`, makes decryption fail.
- KDF parameters, field lengths and file sizes (max 5 MiB) are validated before decrypting, to
  block downgrade and denial-of-service tricks.
- A wrong password and a tampered file give the same error, and no partial plaintext is ever
  written.
- Keys, passwords and plaintext buffers are wiped from memory after use (best effort).

Each `.enc` file is a JSON document:

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "<base64, 32 bytes>" },
  "iv": "<base64, 16 bytes>",
  "metadata": {
    "environment": "production",
    "sourceFile": ".env.production",
    "encryptedAt": "2026-11-07T06:00:00.000Z"
  },
  "authTag": "<base64, 16 bytes>",
  "ciphertext": "<base64>"
}
```

### Files on disk

- Files are written atomically (temp file, `fsync`, rename), so a crash never leaves a half-written
  `.env` or `.enc` file.
- Decrypted files are created readable by you only (mode `0600`).
- All paths from `.dotcrypt.json` must stay inside the project, and dotcrypt refuses to follow
  symlinks out of it. A malicious repository can't make `decrypt` overwrite `~/.bashrc` or make
  `encrypt` pick up `~/.ssh/id_rsa`.
- `init` adds `.env`, `.env.*` and `!.env.*.enc` to `.gitignore` without touching your existing
  rules. `encrypt` and `decrypt` warn if a plaintext file is tracked by Git or not ignored.
- `diff`, `check` and the confirmation prompts only ever print variable names, never values.

### Dashboard

- Listens on `127.0.0.1` only.
- A new random 256-bit token is required on every request. The browser keeps it in
  `sessionStorage` and removes it from the address bar.
- Requests from other hosts or origins are rejected (DNS-rebinding and CSRF protection), with a
  strict Content Security Policy and no-cache headers.
- Only metadata and variable names are sent to the browser. Passwords stay in the tab's memory
  (the **Lock** button clears them) and are never stored.

## Contributing

Bug reports and pull requests are welcome on
[GitHub](https://github.com/zubayerhimel/dotcrypt/issues). See
[DEVELOPMENT.md](https://github.com/zubayerhimel/dotcrypt/blob/main/DEVELOPMENT.md) to run the
project locally.

## License

MIT
