import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';

export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const GITIGNORE_HEADER = '# dotenv-vault-cli: never commit plaintext environment files';
export const BASE_GITIGNORE_RULES = Object.freeze(['.env', '.env.*', '!.env.*.enc']);

export class VaultError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) {
    super(message);
    this.name = 'VaultError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolves a config-supplied relative path, rejecting absolute paths and traversal.
 */
export function resolveInside(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '' || relativePath.includes('\0')) {
    throw new VaultError(`Invalid path: ${JSON.stringify(relativePath)}`);
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new VaultError(`Path must be relative to the project root: ${relativePath}`);
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (resolved === base || !isWithin(base, resolved)) {
    throw new VaultError(`Path escapes the project directory: ${relativePath}`);
  }
  return resolved;
}

export function displayPath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

export function fileExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Guards a path we are about to read or write: it must live inside the project,
 * must not be a symlink, and no symlinked parent directory may lead outside the
 * project. Prevents a malicious repo from redirecting writes (e.g. to ~/.bashrc)
 * or reads (e.g. of ~/.ssh/id_rsa into a committed vault file).
 */
export function assertSafePath(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const shown = displayPath(base, resolved);
  if (resolved === base || !isWithin(base, resolved)) {
    throw new VaultError(`Refusing to access ${resolved}: it is outside the project directory.`);
  }

  let stat = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (stat?.isSymbolicLink()) throw new VaultError(`Refusing to use ${shown}: it is a symbolic link.`);
  if (stat && !stat.isFile()) throw new VaultError(`Refusing to use ${shown}: it is not a regular file.`);

  let dir = path.dirname(resolved);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  if (!isWithin(fs.realpathSync.native(base), fs.realpathSync.native(dir))) {
    throw new VaultError(`Refusing to use ${shown}: its directory resolves outside the project.`);
  }
  return resolved;
}

export function safeReadFile(root, target, { maxSize = MAX_FILE_SIZE } = {}) {
  const resolved = assertSafePath(root, target);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw new VaultError(`File not found: ${displayPath(root, resolved)}`);
    throw err;
  }
  if (stat.size > maxSize) {
    throw new VaultError(`${displayPath(root, resolved)} is larger than the ${maxSize} byte limit.`);
  }
  return fs.readFileSync(resolved);
}

/**
 * Atomic write: data goes to an exclusive temp file in the same directory, is
 * fsync'd, then renamed over the target. A crash never leaves a half-written file.
 */
export function safeWriteFile(root, target, data, { mode = 0o600 } = {}) {
  const resolved = assertSafePath(root, target);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  assertSafePath(root, resolved);

  // Temp name starts with the target's basename so it matches the same ignore rules.
  const tmp = path.join(dir, `${path.basename(resolved)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, resolved);
    try {
      fs.chmodSync(resolved, mode);
    } catch {
      // chmod is best-effort (no-op on some Windows filesystems).
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function buffersEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function toPosix(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True when BASE_GITIGNORE_RULES already ignore this plaintext path. */
export function isCoveredByBaseRules(relPath) {
  const name = path.posix.basename(toPosix(relPath));
  return name === '.env' || (name.startsWith('.env.') && !name.endsWith('.enc'));
}

/**
 * Appends any missing ignore rules for plaintext env files to .gitignore.
 * Never removes or rewrites existing user rules.
 * @returns {string[]} rules that were added.
 */
export function ensureGitignore(root, plaintextFiles = []) {
  const gitignorePath = path.join(root, '.gitignore');
  const content = fileExists(gitignorePath) ? safeReadFile(root, gitignorePath).toString('utf8') : '';
  const existing = new Set(content.split(/\r?\n/).map((line) => line.trim()));

  const wanted = [
    ...BASE_GITIGNORE_RULES,
    ...plaintextFiles
      .map(toPosix)
      .filter((file) => !isCoveredByBaseRules(file))
      .map((file) => `/${file}`),
  ];
  const missing = [...new Set(wanted)].filter((rule) => !existing.has(rule));
  if (missing.length === 0) return [];

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  let block = '';
  if (content.length > 0) block += content.endsWith('\n') ? eol : eol + eol;
  if (!existing.has(GITIGNORE_HEADER)) block += GITIGNORE_HEADER + eol;
  block += missing.join(eol) + eol;

  safeWriteFile(root, gitignorePath, content + block, { mode: 0o644 });
  return missing;
}

function runGit(root, args) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : null;
  }
}

/**
 * Reports whether a path is tracked or ignored by Git. `inRepo` is false when
 * Git is unavailable or root is not inside a work tree.
 */
export function gitStatusOf(root, relPath) {
  if (runGit(root, ['rev-parse', '--is-inside-work-tree']) !== 0) return { inRepo: false };
  const file = toPosix(relPath);
  return {
    inRepo: true,
    tracked: runGit(root, ['ls-files', '--error-unmatch', '--', file]) === 0,
    ignored: runGit(root, ['check-ignore', '-q', '--', file]) === 0,
  };
}

export function parseEnv(content) {
  return dotenv.parse(content);
}

/**
 * Compares variable maps by key. Returns key names only, never values.
 * "added" = only in local, "removed" = only in vault, "changed" = value differs.
 */
export function diffEnv(vaultVars, localVars) {
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const key of Object.keys(localVars)) {
    if (!Object.hasOwn(vaultVars, key)) added.push(key);
    else if (vaultVars[key] !== localVars[key]) changed.push(key);
    else unchanged += 1;
  }
  for (const key of Object.keys(vaultVars)) {
    if (!Object.hasOwn(localVars, key)) removed.push(key);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged };
}

export function hasDifferences({ added, removed, changed }) {
  return added.length + removed.length + changed.length > 0;
}

/** Strips control characters so decrypted key names cannot inject terminal escapes. */
export function sanitizeForTerminal(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}
