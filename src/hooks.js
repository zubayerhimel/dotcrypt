import fs from 'node:fs';
import path from 'node:path';
import { listEnvironments, resolveEnvironment } from './config.js';
import { VaultError, gitOutput } from './utils.js';
import { getVaultStatus } from './vault.js';

export const HOOKS = ['pre-commit', 'post-merge', 'post-checkout'];
const START = '# >>> dotcrypt >>>';
const END = '# <<< dotcrypt <<<';
const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function gitPaths(root) {
  const toplevel = gitOutput(root, ['rev-parse', '--show-toplevel']);
  const hooksDir = gitOutput(root, ['rev-parse', '--git-path', 'hooks']);
  if (!toplevel || !hooksDir) {
    throw new VaultError('This project is not inside a Git repository.', { hint: 'Run "git init" first.' });
  }
  return { toplevel: realpath(toplevel), hooksDir: path.resolve(root, hooksDir) };
}

const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

function hookBlock(hook, projectDir) {
  const project = projectDir ? ` --project ${shellQuote(projectDir)}` : '';
  const localBin = `./${projectDir ? `${projectDir}/` : ''}node_modules/.bin/dotcrypt`;
  // Only pre-commit may stop Git; the others just print reminders. If dotcrypt is not installed, do nothing.
  const onFail = hook === 'pre-commit' ? ' || exit $?' : ' || true';
  return [
    START,
    '# Added by "dotcrypt hooks install". Remove with "dotcrypt hooks uninstall".',
    'if command -v dotcrypt >/dev/null 2>&1; then',
    `  dotcrypt hook ${hook}${project} -- "$@"${onFail}`,
    `elif [ -x ${shellQuote(localBin)} ]; then`,
    `  ${shellQuote(localBin)} hook ${hook}${project} -- "$@"${onFail}`,
    'fi',
    END,
  ].join('\n');
}

function isShellScript(content) {
  const first = content.split('\n', 1)[0];
  return /^#!.*\b(sh|bash|zsh|dash|ksh)\b/.test(first);
}

/** Installs (or refreshes) the dotcrypt block in each hook, keeping any existing hook logic. */
export function installHooks(ctx) {
  const { toplevel, hooksDir } = gitPaths(ctx.root);
  if (toPosix(path.relative(toplevel, hooksDir)).split('/').includes('.husky')) {
    throw new VaultError('This repository uses husky, which manages the Git hooks itself.', {
      hint: 'Add "npx dotcrypt hook pre-commit" to .husky/pre-commit and "npx dotcrypt hook post-merge" to .husky/post-merge instead.',
    });
  }
  const projectDir = toPosix(path.relative(toplevel, realpath(ctx.root)));
  fs.mkdirSync(hooksDir, { recursive: true });

  return HOOKS.map((hook) => {
    const file = path.join(hooksDir, hook);
    const block = hookBlock(hook, projectDir);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `#!/bin/sh\n${block}\n`, { mode: 0o755 });
      return { hook, file, action: 'created' };
    }
    const content = fs.readFileSync(file, 'utf8');
    if (BLOCK.test(content)) {
      const next = content.replace(BLOCK, (match) => `${match.startsWith('\n') ? '\n' : ''}${block}\n`);
      if (next !== content) fs.writeFileSync(file, next);
      fs.chmodSync(file, 0o755);
      return { hook, file, action: next === content ? 'unchanged' : 'updated' };
    }
    if (!isShellScript(content)) {
      return { hook, file, action: 'skipped', reason: 'existing hook is not a shell script' };
    }
    const [shebang, ...rest] = content.split('\n');
    fs.writeFileSync(file, [shebang, block, ...rest].join('\n'));
    fs.chmodSync(file, 0o755);
    return { hook, file, action: 'added' };
  });
}

/** Removes the dotcrypt block from each hook; deletes hooks that contained nothing else. */
export function uninstallHooks(ctx) {
  const { hooksDir } = gitPaths(ctx.root);
  return HOOKS.map((hook) => {
    const file = path.join(hooksDir, hook);
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!BLOCK.test(content)) return { hook, file, action: 'not-installed' };
    const next = content.replace(BLOCK, '\n');
    if (next.replace(/^#!.*$/m, '').trim() === '') {
      fs.rmSync(file);
      return { hook, file, action: 'removed' };
    }
    fs.writeFileSync(file, next);
    return { hook, file, action: 'cleaned' };
  });
}

const NON_SECRET_SUFFIX = /\.(enc|example|sample|template|dist|defaults)$/i;

/** True for file names that look like plaintext env files (.env, .env.local, .env.production, ...). */
export function looksLikePlaintextEnv(file) {
  const base = path.posix.basename(toPosix(file));
  return /^\.env(\..+)?$/.test(base) && !NON_SECRET_SUFFIX.test(base);
}

/** Checks the Git index before a commit: staged plaintext env files block it, unshared changes warn. */
export function preCommitCheck(ctx) {
  const { toplevel } = gitPaths(ctx.root);
  const staged = (gitOutput(ctx.root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']) ?? '')
    .split('\0')
    .filter(Boolean);
  const mapped = new Set(
    listEnvironments(ctx.config).map((name) =>
      toPosix(path.relative(toplevel, realpath(resolveEnvironment(ctx, name).plainPath))),
    ),
  );
  const blocked = staged.filter((file) => mapped.has(file) || looksLikePlaintextEnv(file));
  const unshared = getVaultStatus(ctx)
    .environments.filter((env) => env.sync === 'local-changes' || env.sync === 'conflict')
    .map((env) => env.name);
  return { blocked, unshared };
}

/** After a pull or branch switch: which environments have new changes to download. */
export function incomingCheck(ctx) {
  return getVaultStatus(ctx)
    .environments.filter((env) => env.sync === 'incoming-changes' || env.sync === 'conflict')
    .map((env) => ({ name: env.name, sync: env.sync }));
}
