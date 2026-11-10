# dotcrypt

Securely sync multiple `.env` environments across machines **through your existing Git repository**.
Plaintext env files stay local and git-ignored; only AES-256-GCM encrypted `.enc` files and a shared
`.dotcrypt.json` configuration are committed.

```
.dotcrypt.json             <- committed: environments + file mappings (no secrets)
.env.development           <- local only (git-ignored)
.env.development.enc       <- committed: encrypted with AES-256-GCM
.env.production            <- local only (git-ignored)
.env.production.enc        <- committed
```

## Installation

```bash
npm install -g dotcrypt
dotcrypt --help
```

### From source

Requires Node.js **20.19+** (needed to build the dashboard; the CLI alone runs on 18.17+).

```bash
git clone https://github.com/zubayerhimel/dotcrypt.git
cd dotcrypt
npm run setup       # installs CLI + dashboard dependencies and builds the dashboard
npm link            # exposes the `dotcrypt` command globally
dotcrypt --help
```

`npm run setup` is the same as running these one by one:

```bash
npm install                 # CLI dependencies
npm --prefix ui install     # dashboard dependencies
npm run build:ui            # builds the dashboard into ui/dist
```

Re-run `npm run build:ui` after pulling changes to the dashboard code.

> **Windows PowerShell:** if you get "running scripts is disabled on this system", use `npm.cmd`
> instead of `npm` (e.g. `npm.cmd run setup`, `npm.cmd link`), or run the commands from Command Prompt.

To uninstall the global link: `npm unlink -g dotcrypt`.

## Quick start

```bash
cd path/to/your-project
dotcrypt init        # creates .dotcrypt.json and updates .gitignore
dotcrypt ui          # opens the dashboard in your browser
```

Prefer the terminal? Everything in the dashboard is also available as a CLI command (see below).

## Commands

| Command | Description |
| --- | --- |
| `status` | Show what changed for each environment and what to do next. No password needed. |
| `init [-n name] [--envs a,b,c] [-d env] [-y] [-f]` | Create `.dotcrypt.json` and add ignore rules for plaintext env files to `.gitignore`. |
| `encrypt [-e env] [-p password] [-f] [--replace]` | Encrypt the mapped local file (e.g. `.env.staging`) into its `.enc` file. |
| `decrypt [-e env] [-p password] [-f]` | Decrypt the `.enc` file into the mapped local file. |
| `rotate-key [-e env] [-o old] [-n new]` | Re-encrypt with a new password, a fresh salt and a fresh IV. |
| `diff [-e env] [-p password] [--exit-code]` | Show **key names** that were added / removed / changed. Values are never printed. |
| `ui [--port n] [--no-open]` | Open the local web dashboard (see below). |

If `-e` is omitted you are prompted to pick an environment (non-interactive runs fall back to
`defaultEnvironment`).

### Supplying passwords

Passwords are resolved in this order:

1. CLI flag (`-p`, `-o`, `-n`) — works, but prints a warning because flags leak into shell
   history and process listings.
2. Environment variable — `DOTCRYPT_PASSWORD` (and `DOTCRYPT_NEW_PASSWORD` for the new
   password in `rotate-key`). Recommended for CI.
3. Interactive masked prompt (recommended for humans). New passwords must be at least 12
   characters and are asked twice.

### Overwrite protection

- `decrypt` never silently replaces a local file that differs from the vault: it shows which keys
  would be lost/changed and asks for confirmation. Use `--force` to skip the prompt.
- `encrypt` shows a key-level summary of what will change in the vault and asks before
  overwriting. If the files are identical, nothing is written (no Git churn).
- `encrypt` **verifies your password against the existing `.enc` file**. This prevents a
  teammate from accidentally re-encrypting a shared vault with a different password. Change
  passwords with `rotate-key`. To deliberately discard a vault file that is unreadable, belongs to
  another environment, or uses a different password, pass `--replace` (`--force` alone never does
  this). When the password was typed at a prompt, you must re-enter it before the vault is replaced.
- `init` refuses to overwrite an existing `.dotcrypt.json` without confirmation or `--force`.
- Non-interactive sessions (CI, pipes) never prompt; they fail safely unless `--force` is given.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General error, aborted, or (`diff --exit-code`) differences found |
| `2` | Wrong password or corrupted / tampered encrypted file |
| `130` | Cancelled at a prompt (Ctrl+C) |

## `.dotcrypt.json`

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

You may edit mappings by hand (e.g. `"file": "apps/api/.env"`). Validation rules:

- Environment names: 1–64 chars of letters, digits, `-`, `_`.
- Paths must be relative and stay inside the project (no absolute paths, no `..` escapes).
- `encryptedFile` must end in `.enc`; `file` must not.
- No two mappings may share a path (compared case-insensitively).

Custom plaintext paths that the default `.env` / `.env.*` rules don't cover are added to
`.gitignore` explicitly the next time you run `init`.

## Team workflow

The idea in one sentence: **your secrets live in normal `.env` files; you share them by
encrypting them into `.enc` files and pushing those through Git.**

The easiest way to work is the dashboard (`dotcrypt ui`). Each environment card says in plain
words what state it is in and shows one button for the next step. `dotcrypt status` shows the
same thing in the terminal.

**Setting up (once, by one person):**

1. Run `dotcrypt init` (or open `dotcrypt ui` and click through the setup).
2. Create your `.env` files as usual and click **Share with team** on each card (or run
   `dotcrypt encrypt -e <env>`). You choose a password per environment.
3. Commit and push `.dotcrypt.json`, `.gitignore` and the `.enc` files. The card shows the exact
   command.
4. Give teammates the passwords privately (a password manager, not chat or the repo).

**You added or changed a variable:**

1. Edit the `.env` file in your editor.
2. The card now says **You have unshared changes**. Click **Share changes**
   (CLI: `dotcrypt encrypt -e <env>`).
3. Commit and push the `.enc` file. The card shows the command, for example:
   `git add .env.development.enc && git commit -m "Update development secrets" && git push`.

**A teammate changed something:**

1. `git pull`.
2. The card says **New changes from your team**. Click **Get latest**
   (CLI: `dotcrypt decrypt -e <env>`).

**A new teammate joins:** they clone the repo, run `npx dotcrypt ui`, click **Get secrets** on
each card, and enter the password you gave them.

**Both of you changed the same environment:** the card says **Changed on both sides**. Click
**Review** to see which variable names differ, then choose **Keep mine and share it** or **Use
team's version**. If you need parts of both, copy the missing variables into your file first,
then keep yours.

### How dotcrypt knows what changed

`.enc` files are re-encrypted with a fresh random IV every time, so comparing timestamps or file
contents can't tell who changed what. Instead, every time you share, get, or compare an
environment, dotcrypt records fingerprints (SHA-256) of both files at that moment in
`.git/dotcrypt/sync-state.json`. That file is local to your clone and never committed. Later it
compares the current files with those fingerprints:

| State | Meaning | Next step |
| --- | --- | --- |
| Up to date | Neither file changed since your last sync. | Nothing. |
| You have unshared changes | Your `.env` changed. | Share, then commit and push. |
| New changes from your team | The `.enc` changed (e.g. after `git pull`). | Get latest. |
| Changed on both sides | Both changed. | Review and choose a version. |
| Not shared yet / Ready to download | Only one of the two files exists. | Share / Get secrets. |
| Not checked yet | No fingerprint yet (e.g. first run on an existing checkout). | Compare once with the password. |

Neither the dashboard nor `status` needs a password to show these states.

**Someone leaves the team / password leaked:**

```bash
dotcrypt rotate-key -e production
git commit -am "Rotate production vault password" && git push
```

> ⚠️ Rotating the password does **not** revoke secrets. Anyone who had the old password can still
> decrypt old versions of the `.enc` file from Git history. After a departure or leak, rotate the
> **underlying secrets** (API keys, DB passwords) too, then re-encrypt.

**Merge conflicts in `.enc` files:** encrypted files can't be merged textually. Resolve by taking
one side (`git checkout --theirs .env.x.enc`), running `decrypt`, re-applying your changes to the
plaintext file, and running `encrypt` again.

**CI usage:**

```bash
DOTCRYPT_PASSWORD="$VAULT_PASSWORD_PRODUCTION" dotcrypt decrypt -e production --force
```

## Security architecture

### Encrypted file format

Each `.enc` file is a JSON envelope:

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

### Cryptographic design

- **Cipher:** AES-256-GCM (authenticated encryption) via `node:crypto`, 128-bit auth tag
  enforced with `authTagLength` on both encrypt and decrypt.
- **Key derivation:** `crypto.scryptSync` → 256-bit key. Default cost `N=2^15, r=8, p=1`
  (~32 MiB, OWASP baseline). Passwords are Unicode NFC-normalized so the same password works on
  every OS/keyboard.
- **Fresh randomness every run:** a new 32-byte salt and new 16-byte IV come from the CSPRNG
  (`crypto.randomBytes`) on every `encrypt` and `rotate-key`. IVs are never fixed, reused, or
  derived; because the key is also fresh per salt, (key, IV) reuse is cryptographically
  negligible.
- **Authenticated header (AAD):** the format version, algorithm, all KDF parameters, salt, IV,
  and metadata (environment, source file, timestamp) are bound to the ciphertext as GCM
  Additional Authenticated Data. Any modification — including swapping `staging.enc` into
  `production.enc` or editing the environment label — fails authentication.
- **Environment binding:** on decrypt, the authenticated `metadata.environment` must match the
  requested environment.
- **Downgrade / DoS resistance:** KDF parameters read from files are bounds-checked (N must be a
  power of two in `[2^14, 2^20]`, `r ∈ [8, 32]`, `p ∈ [1, 16]`, memory ≤ 256 MiB). Base64 fields,
  salt/IV/tag lengths, and file sizes (5 MiB) are strictly validated before any crypto runs.
- **Uniform failure:** a wrong password and a tampered file produce the same error (GCM cannot and
  should not distinguish them); no partial plaintext is ever written.
- **Key hygiene:** derived keys, password byte buffers and plaintext buffers are zeroed after use
  (best-effort in a garbage-collected runtime).

### Filesystem safety

- **Atomic writes:** output is written to an exclusive (`wx`) temp file, `fsync`ed, then renamed
  over the target, so crashes never leave truncated `.env` or `.enc` files.
- **Restrictive permissions:** decrypted plaintext files are created with mode `0600`.
- **Path confinement:** all paths from `.dotcrypt.json` must resolve inside the project root.
- **Symlink protection:** the tool refuses to read or write through symlinks, or through
  symlinked directories that resolve outside the project. A malicious repository therefore can't
  make `decrypt` overwrite e.g. `~/.bashrc`, or make `encrypt` pull `~/.ssh/id_rsa` into a
  committed file.
- **Git hygiene:** `init` appends `.env`, `.env.*` and `!.env.*.enc` (plus explicit entries for
  custom paths) to `.gitignore` without touching existing rules. `encrypt`/`decrypt` warn loudly if
  a plaintext file is tracked by Git or not ignored.
- **No secret output:** `diff` and the overwrite summaries print key names only; key names are
  sanitized of control characters to prevent terminal escape injection.

### Threat model & limitations

- Protects secrets **at rest in Git** (hosting provider, forks, leaked clones) against anyone
  without the password.
- Does **not** protect against a compromised developer machine, or against someone who holds the
  password. Old ciphertexts in Git history remain decryptable with old passwords.
- Security depends on password strength. Use long random passphrases from a password manager and a
  separate password per environment.
- Not a replacement for a full secrets manager (per-user access control, audit logs, automatic
  rotation). It is designed for small, trusted teams.

## Web dashboard

### Opening the dashboard

1. Make sure you ran `npm run setup` (or `npm run build:ui`) once in this repository.
2. In a terminal, go to the project whose env files you want to manage (the folder with
   `.dotcrypt.json`, or any folder if you want to create one from the dashboard).
3. Run:

   ```bash
   dotcrypt ui                      # random free port, opens your browser
   dotcrypt ui --port 4600          # fixed port
   dotcrypt ui --no-open            # just print the URL
   ```

4. The terminal prints a URL like `http://127.0.0.1:53412/?token=3f9c…`. Your browser opens it
   automatically; if it does not, copy the **full** URL (including `?token=`) into your browser.
5. Leave the terminal open while you use the dashboard. Press **Ctrl+C** to stop it.

Each run creates a new token, so old URLs stop working after a restart. If the page says
"Session token missing or expired", open the URL from the current run again. If it says the
dashboard assets are not built, run `npm run build:ui` in this repository.

### What it does

A local dashboard built with React, [shadcn/ui](https://ui.shadcn.com) (Base UI primitives) and
Tailwind. It shows:

- a short "How sharing works" guide (hide it, and reopen it from **How it works** in the header)
- one card per environment with a plain-language state (see [Team workflow](#how-dotcrypt-knows-what-changed))
  and a single button for the next step: **Share changes**, **Get latest**, **Review**, ...
- the Git command to send a shared `.enc` file to your team (with a copy button), and a hint when a
  teammate pushed something newer
- Git safety: whether plaintext files are ignored or (dangerously) tracked, and a one-click fix for
  missing `.gitignore` rules
- an activity log for the session

Less common actions (compare, force share or get, change password, make default) are in each
card's **⋯** menu. Changes that overwrite a file show the variable names involved and ask for
confirmation, just like the CLI. The dashboard refreshes every 5 seconds, so changes made in the terminal or by `git pull`
show up automatically.

### Dashboard security model

- **Loopback only.** The server binds to `127.0.0.1` and never to `0.0.0.0`.
- **Per-run secret token.** A random 256-bit token is generated on every start and required as a
  bearer token on every API call, compared in constant time. The browser moves it from the URL into
  `sessionStorage` and removes it from the address bar. Do not share the printed URL.
- **DNS-rebinding and CSRF protection.** Requests whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` are rejected (421). Writes require `Content-Type: application/json`, a matching
  `Origin`, and a same-origin `Sec-Fetch-Site`.
- **Strict headers.** A restrictive CSP (`script-src 'self'`, `frame-ancestors 'none'`, …),
  `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and `Cache-Control: no-store` on API responses.
- **No secret values leave the server.** The API returns metadata and key names only. Passwords are
  sent per request, held only in the tab's memory (the **Lock** button clears them), and never
  stored in `localStorage` or on disk. Request bodies are capped at 64 KB.

### Developing the dashboard

```bash
# terminal 1, inside any project with a vault
dotcrypt ui --port 4600 --no-open        # note the token it prints
# terminal 2, in this repository
VAULT_API_PORT=4600 npm run dev:ui               # Vite on http://localhost:5173, /api is proxied
# open http://localhost:5173/?token=<token>
```

UI code lives in `ui/src` (`App.tsx`, `components/`, `lib/api.ts`). Add more shadcn components with
`npx shadcn@latest add <component>` from the `ui/` directory.

## Development

```bash
npm install
npm test
```

Source layout: `src/crypto.js` (envelope format and AES-256-GCM/scrypt), `src/config.js`
(`.dotcrypt.json`), `src/utils.js` (filesystem and Git safety), `src/vault.js` (operations shared
by the CLI and dashboard), `src/server.js` (dashboard server), `bin/cli.js` (Commander CLI) and
`ui/` (dashboard).

## License

MIT
