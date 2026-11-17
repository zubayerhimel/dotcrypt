# Developing dotcrypt

Instructions for working on dotcrypt from this repository. For using the published package, see
[README.md](README.md).

> This file is not included in the npm package (see `files` in `package.json`).

## Requirements

- Node.js **20.19+** to build the dashboard (the CLI alone runs on 18.17+).
- npm.

## Set up and run locally

```bash
npm run setup       # installs CLI + dashboard dependencies and builds the dashboard
npm link            # exposes your local `dotcrypt` command globally
dotcrypt --help
```

`npm run setup` is the same as:

```bash
npm install                 # CLI dependencies
npm --prefix ui install     # dashboard dependencies
npm run build:ui            # builds the dashboard into ui/dist
```

Re-run `npm run build:ui` after changing or pulling dashboard code; `dotcrypt ui` serves the
built files from `ui/dist` and returns "Dashboard assets are not built" if they are missing.

You can also run the CLI without linking: `node bin/cli.js <command>`.

To remove the global link: `npm unlink -g dotcrypt`.

> **Windows PowerShell:** if you get "running scripts is disabled on this system", use `npm.cmd`
> instead of `npm` (e.g. `npm.cmd run setup`, `npm.cmd link`), or use Command Prompt.

## Tests

```bash
npm test            # node --test
```

CI (`.github/workflows/ci.yml`) runs the tests on Node 18, 20, 22 and 24, and checks that the
package packs with the dashboard built (`npm pack --dry-run`).

## Developing the dashboard

```bash
# terminal 1, inside any project with a .dotcrypt.json
dotcrypt ui --port 4600 --no-open        # note the token it prints

# terminal 2, in this repository
VAULT_API_PORT=4600 npm run dev:ui       # Vite on http://localhost:5173, /api is proxied

# open http://localhost:5173/?token=<token>
```

The dashboard is React + [shadcn/ui](https://ui.shadcn.com) (Base UI primitives) + Tailwind. Code
lives in `ui/src` (`App.tsx`, `components/`, `lib/api.ts`). Add shadcn components with
`npx shadcn@latest add <component>` from the `ui/` directory.

## Source layout

| Path | Purpose |
| --- | --- |
| `bin/cli.js` | Commander CLI entry point |
| `src/crypto.js` | Envelope format, AES-256-GCM and scrypt |
| `src/config.js` | `.dotcrypt.json` loading and validation |
| `src/envfile.js` | `.env` key validation and in-place editing (used by `set` / `unset`) |
| `src/utils.js` | Filesystem and Git safety helpers |
| `src/vault.js` | Operations shared by the CLI and dashboard |
| `src/sync.js` | Sync-state fingerprints (`.git/dotcrypt/sync-state.json`) |
| `src/hooks.js` | Git hook install / uninstall and hook checks |
| `src/server.js` | Local dashboard HTTP server |
| `ui/` | Dashboard (Vite + React) |
| `test/` | `node:test` test suites |

## Releasing

```bash
npm version patch|minor|major   # runs tests first, then pushes the commit and tag
npm publish                      # prepack builds the dashboard, prepublishOnly runs tests
```

Update `CHANGELOG.md` before releasing. Keep `README.md` focused on end users: it is the page
shown on npm.
