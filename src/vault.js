import fs from 'node:fs';
import path from 'node:path';

import {
  CONFIG_FILENAME,
  ENV_NAME_PATTERN,
  createConfig,
  defaultFileMapping,
  listEnvironments,
  resolveEnvironment,
  saveConfig,
} from './config.js';
import { DecryptionError, EnvelopeFormatError, decrypt, encrypt, parseEnvelope, serializeEnvelope } from './crypto.js';
import {
  ConfirmationRequiredError,
  VaultError,
  buffersEqual,
  diffEnv,
  ensureGitignore,
  fileExists,
  gitShareStatus,
  gitStatusOf,
  parseEnv,
  safeReadFile,
  safeWriteFile,
} from './utils.js';
import { assertValidKey, editEnvContent } from './envfile.js';
import { computeSync, fingerprint, fingerprintFile, openSyncState } from './sync.js';

export const MIN_PASSWORD_LENGTH = 12;

export function newPasswordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.trim() !== password) return 'Password must not start or end with whitespace.';
  return null;
}

export function assertNewPassword(password) {
  const problem = newPasswordProblem(password);
  if (problem) throw new VaultError(problem, { code: 'WEAK_PASSWORD' });
}

function assertPasswordProvided(password, label = 'Password') {
  if (typeof password !== 'string' || password.length === 0) {
    throw new VaultError(`${label} is required.`, { code: 'INVALID_INPUT' });
  }
}

/** Plaintext-exposure warnings for a file path (empty when safe or not a Git repo). */
export function plaintextWarnings(root, relFile) {
  const status = gitStatusOf(root, relFile);
  if (!status.inRepo) return [];
  if (status.tracked) {
    return [
      `${relFile} is TRACKED by Git! Remove it with "git rm --cached ${relFile}" and rotate the secrets it contains.`,
    ];
  }
  if (!status.ignored) return [`${relFile} is not ignored by Git. Add it to .gitignore.`];
  return [];
}

export function loadEnvelope(ctx, env) {
  if (!fileExists(env.encPath)) {
    throw new VaultError(`Encrypted file ${env.encryptedFile} not found for environment "${env.name}".`, {
      code: 'NOT_FOUND',
      hint: `Run "dotcrypt encrypt -e ${env.name}" first, or pull the latest changes from Git.`,
    });
  }
  try {
    return parseEnvelope(safeReadFile(ctx.root, env.encPath));
  } catch (err) {
    if (err instanceof EnvelopeFormatError) {
      throw new VaultError(`${env.encryptedFile} is not a valid vault file: ${err.message}`, { code: 'INVALID_VAULT' });
    }
    throw err;
  }
}

/**
 * Classifies an environment's vault file without a password:
 * "missing", "valid" (with its envelope), or "unreadable" (with the problem).
 */
export function inspectVault(ctx, env) {
  if (!fileExists(env.encPath)) return { status: 'missing' };
  try {
    const envelope = loadEnvelope(ctx, env);
    if (envelope.metadata.environment !== env.name) {
      return {
        status: 'unreadable',
        problem: `${env.encryptedFile} belongs to environment "${envelope.metadata.environment}", not "${env.name}".`,
      };
    }
    return { status: 'valid', envelope };
  } catch (err) {
    if (err instanceof VaultError && err.code === 'INVALID_VAULT') return { status: 'unreadable', problem: err.message };
    throw err;
  }
}

function decryptOrFail(envelope, password, env) {
  try {
    return decrypt(envelope, password, { expectedEnvironment: env.name });
  } catch (err) {
    if (err instanceof DecryptionError) throw new VaultError(err.message, { exitCode: 2, code: 'DECRYPT_FAILED' });
    throw err;
  }
}

function fileInfo(root, absPath) {
  try {
    if (!fileExists(absPath)) return { exists: false };
    const stat = fs.statSync(absPath);
    return { exists: true, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch (err) {
    return { exists: true, error: err.message };
  }
}

/** Describes an environment without decrypting anything. Never exposes secret values. */
export function getEnvironmentStatus(ctx, name, syncState = openSyncState(ctx.root)) {
  const env = resolveEnvironment(ctx, name);
  const local = fileInfo(ctx.root, env.plainPath);
  const vault = { ...fileInfo(ctx.root, env.encPath), valid: false };

  if (vault.exists && !vault.error) {
    try {
      const envelope = loadEnvelope(ctx, env);
      vault.valid = true;
      vault.encryptedAt = envelope.metadata.encryptedAt;
      vault.environment = envelope.metadata.environment;
      vault.environmentMatches = envelope.metadata.environment === env.name;
      vault.kdf = { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p };
    } catch (err) {
      vault.error = err.message;
    }
  }

  const git = gitStatusOf(ctx.root, env.file);
  const vaultGit = gitStatusOf(ctx.root, env.encryptedFile);
  const broken = vault.exists && !(vault.valid && vault.environmentMatches);
  const sync = broken
    ? 'broken'
    : computeSync({
        localExists: local.exists,
        vaultExists: vault.exists,
        localHash: local.exists && vault.exists ? fingerprintFile(env.plainPath) : null,
        vaultHash: local.exists && vault.exists ? fingerprintFile(env.encPath) : null,
        baseline: syncState.get(env.name),
      });

  return {
    name: env.name,
    file: env.file,
    encryptedFile: env.encryptedFile,
    isDefault: ctx.config.defaultEnvironment === env.name,
    sync,
    local,
    vault,
    git,
    vaultGit: vaultGit.inRepo
      ? { inRepo: true, tracked: vaultGit.tracked, ...gitShareStatus(ctx.root, env.encryptedFile) }
      : { inRepo: false },
  };
}

export function getVaultStatus(ctx) {
  const syncState = openSyncState(ctx.root);
  const environments = listEnvironments(ctx.config).map((name) => getEnvironmentStatus(ctx, name, syncState));
  return {
    root: ctx.root,
    configFile: CONFIG_FILENAME,
    vault: ctx.config.vault,
    defaultEnvironment: ctx.config.defaultEnvironment,
    environments,
  };
}

/** Records that the local file and the vault file currently hold the same content. */
function markSynced(ctx, env, plaintext) {
  openSyncState(ctx.root).set(env.name, { local: fingerprint(plaintext), vault: fingerprintFile(env.encPath) });
}

/**
 * Encrypts the local file into the vault file.
 * Options:
 *  - overwrite: replace an existing vault file whose contents differ.
 *  - replaceExisting: discard an existing vault file that is unreadable or protected by another password.
 * @throws {ConfirmationRequiredError} when approval is needed.
 */
export function encryptEnvironment(ctx, name, password, { overwrite = false, replaceExisting = false } = {}) {
  assertPasswordProvided(password);
  const env = resolveEnvironment(ctx, name);
  if (!fileExists(env.plainPath)) {
    throw new VaultError(`Local file ${env.file} not found for environment "${env.name}".`, { code: 'NOT_FOUND' });
  }
  const warnings = plaintextWarnings(ctx.root, env.file);
  const plaintext = safeReadFile(ctx.root, env.plainPath);

  try {
    const vaultState = inspectVault(ctx, env);
    const vaultExisted = vaultState.status !== 'missing';
    const existing = vaultState.status === 'valid' ? vaultState.envelope : null;
    if (vaultState.status === 'unreadable') {
      if (!replaceExisting) {
        throw new ConfirmationRequiredError(vaultState.problem, {
          reason: 'unreadable-vault',
          hint: 'Replacing it creates a new vault file with this password.',
        });
      }
      warnings.push(`Replaced unreadable ${env.encryptedFile}.`);
    }

    let previous = null;
    if (existing) {
      try {
        previous = decrypt(existing, password, { expectedEnvironment: env.name });
      } catch (err) {
        if (!(err instanceof DecryptionError)) throw err;
        // Guards against a teammate accidentally splitting the vault onto a different password.
        if (!replaceExisting) {
          throw new ConfirmationRequiredError(
            `Cannot verify the password against the existing ${env.encryptedFile}. ${err.message}`,
            {
              reason: 'password-mismatch',
              hint: 'To change the password use rotate-key. Replacing discards the existing vault file.',
            },
          );
        }
        warnings.push(`Replaced ${env.encryptedFile}, which was protected by a different password.`);
      }
    }
    if (!previous) assertNewPassword(password);

    let diff;
    if (previous) {
      try {
        if (buffersEqual(previous, plaintext)) {
          markSynced(ctx, env, plaintext);
          return { status: 'unchanged', environment: env.name, warnings };
        }
        diff = diffEnv(parseEnv(previous), parseEnv(plaintext));
      } finally {
        previous.fill(0);
      }
      if (!overwrite) {
        throw new ConfirmationRequiredError(`Overwrite ${env.encryptedFile} with the contents of ${env.file}?`, {
          reason: 'overwrite',
          diff,
        });
      }
    }

    const envelope = encrypt(plaintext, password, { environment: env.name, sourceFile: env.file });
    safeWriteFile(ctx.root, env.encPath, serializeEnvelope(envelope), { mode: 0o644 });
    markSynced(ctx, env, plaintext);
    return { status: vaultExisted ? 'updated' : 'created', environment: env.name, diff, warnings };
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Decrypts the vault file into the local file.
 * @throws {ConfirmationRequiredError} when the local file differs and overwrite is false.
 */
export function decryptEnvironment(ctx, name, password, { overwrite = false } = {}) {
  assertPasswordProvided(password);
  const env = resolveEnvironment(ctx, name);
  const envelope = loadEnvelope(ctx, env);
  const plaintext = decryptOrFail(envelope, password, env);

  try {
    const localExisted = fileExists(env.plainPath);
    if (localExisted) {
      const current = safeReadFile(ctx.root, env.plainPath);
      try {
        if (buffersEqual(current, plaintext)) {
          markSynced(ctx, env, plaintext);
          return { status: 'unchanged', environment: env.name, warnings: plaintextWarnings(ctx.root, env.file) };
        }
        if (!overwrite) {
          throw new ConfirmationRequiredError(`Overwrite local ${env.file}?`, {
            reason: 'overwrite',
            diff: diffEnv(parseEnv(plaintext), parseEnv(current)),
          });
        }
      } finally {
        current.fill(0);
      }
    }

    safeWriteFile(ctx.root, env.plainPath, plaintext, { mode: 0o600 });
    markSynced(ctx, env, plaintext);
    return {
      status: localExisted ? 'updated' : 'created',
      environment: env.name,
      warnings: plaintextWarnings(ctx.root, env.file),
    };
  } finally {
    plaintext.fill(0);
  }
}

export function rotateEnvironmentKey(ctx, name, oldPassword, newPassword) {
  assertPasswordProvided(oldPassword, 'Current password');
  assertPasswordProvided(newPassword, 'New password');
  const env = resolveEnvironment(ctx, name);
  const envelope = loadEnvelope(ctx, env);
  const plaintext = decryptOrFail(envelope, oldPassword, env);

  try {
    assertNewPassword(newPassword);
    if (newPassword === oldPassword) {
      throw new VaultError('The new password must differ from the current password.', { code: 'INVALID_INPUT' });
    }
    const rotated = encrypt(plaintext, newPassword, { environment: env.name, sourceFile: env.file });

    // Verify the new file round-trips before replacing the old one.
    const check = decrypt(rotated, newPassword, { expectedEnvironment: env.name });
    const ok = buffersEqual(check, plaintext);
    check.fill(0);
    if (!ok) throw new VaultError('Verification of the re-encrypted data failed. The original file was not modified.');

    const syncState = openSyncState(ctx.root);
    const baseline = syncState.get(env.name);
    const wasSynced = baseline?.vault === fingerprintFile(env.encPath);
    safeWriteFile(ctx.root, env.encPath, serializeEnvelope(rotated), { mode: 0o644 });
    if (wasSynced) syncState.set(env.name, { local: baseline.local, vault: fingerprintFile(env.encPath) });
    return { status: 'rotated', environment: env.name };
  } finally {
    plaintext.fill(0);
  }
}

/** Throws DECRYPT_FAILED if the password cannot open the environment's vault file. */
export function verifyPassword(ctx, name, password) {
  assertPasswordProvided(password);
  const env = resolveEnvironment(ctx, name);
  decryptOrFail(loadEnvelope(ctx, env), password, env).fill(0);
}

/** Decrypts an environment in memory and returns its variables. Nothing is written to disk. */
export function readEnvironmentVariables(ctx, name, password) {
  assertPasswordProvided(password);
  const env = resolveEnvironment(ctx, name);
  const plaintext = decryptOrFail(loadEnvelope(ctx, env), password, env);
  try {
    return parseEnv(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Compares variable names across environments' vault files to find variables that exist in one
 * environment but are missing in another. Values are never returned.
 * `passwords` maps environment name to password; environments without one are reported as "locked".
 */
export function compareEnvironments(ctx, passwords = {}, names = listEnvironments(ctx.config)) {
  const environments = [];
  const keysByEnv = new Map();
  for (const name of names) {
    const env = resolveEnvironment(ctx, name);
    if (!fileExists(env.encPath)) {
      environments.push({ name: env.name, state: 'no-vault' });
      continue;
    }
    const password = passwords[env.name];
    if (typeof password !== 'string' || !password) {
      environments.push({ name: env.name, state: 'locked' });
      continue;
    }
    try {
      const keys = Object.keys(readEnvironmentVariables(ctx, env.name, password));
      keysByEnv.set(env.name, new Set(keys));
      environments.push({ name: env.name, state: 'compared', count: keys.length });
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      environments.push({ name: env.name, state: err.code === 'DECRYPT_FAILED' ? 'wrong-password' : 'unreadable', error: err.message });
    }
  }

  const compared = [...keysByEnv.keys()];
  const allKeys = [...new Set([...keysByEnv.values()].flatMap((keys) => [...keys]))].sort();
  const missing = [];
  let shared = 0;
  for (const key of allKeys) {
    const missingFrom = compared.filter((name) => !keysByEnv.get(name).has(key));
    if (missingFrom.length) missing.push({ key, missingFrom, presentIn: compared.filter((name) => !missingFrom.includes(name)) });
    else shared += 1;
  }
  return { environments, compared, missing, shared };
}

/**
 * Sets and/or removes variables in the shared vault file, and applies the same edit to the local file
 * when it exists. Other lines, comments and formatting are kept.
 * Returns the keys that actually changed; status is "unchanged" when nothing did.
 */
export function updateEnvironmentVariables(ctx, name, password, { set = {}, unset = [] } = {}) {
  assertPasswordProvided(password);
  for (const key of [...Object.keys(set), ...unset]) assertValidKey(key);
  const env = resolveEnvironment(ctx, name);
  const envelope = loadEnvelope(ctx, env);
  const plaintext = decryptOrFail(envelope, password, env);
  const localBefore = fileExists(env.plainPath) ? safeReadFile(ctx.root, env.plainPath) : null;

  try {
    const before = parseEnv(plaintext);
    const changed = { set: [], unset: [], missing: [] };
    for (const [key, value] of Object.entries(set)) if (before[key] !== value) changed.set.push(key);
    for (const key of unset) (Object.hasOwn(before, key) ? changed.unset : changed.missing).push(key);
    if (!changed.set.length && !changed.unset.length) return { status: 'unchanged', environment: env.name, ...changed };

    const syncState = openSyncState(ctx.root);
    const baseline = syncState.get(env.name);
    const vaultWasBaseline = baseline?.vault === fingerprintFile(env.encPath);
    const localWasInSync =
      localBefore !== null &&
      (buffersEqual(localBefore, plaintext) || (vaultWasBaseline && baseline.local === fingerprint(localBefore)));

    const nextVault = Buffer.from(editEnvContent(plaintext.toString('utf8'), { set, unset }), 'utf8');
    const nextLocal = localBefore && Buffer.from(editEnvContent(localBefore.toString('utf8'), { set, unset }), 'utf8');
    try {
      const updated = encrypt(nextVault, password, { environment: env.name, sourceFile: env.file });
      safeWriteFile(ctx.root, env.encPath, serializeEnvelope(updated), { mode: 0o644 });
      if (nextLocal) safeWriteFile(ctx.root, env.plainPath, nextLocal, { mode: 0o600 });

      // Keep "unshared changes" visible if the local file already had some; otherwise both sides are in sync.
      const vaultHash = fingerprintFile(env.encPath);
      if (localWasInSync) syncState.set(env.name, { local: fingerprint(nextLocal), vault: vaultHash });
      else if (vaultWasBaseline) syncState.set(env.name, { local: baseline.local, vault: vaultHash });
    } finally {
      nextVault.fill(0);
      nextLocal?.fill(0);
    }
    return {
      status: 'updated',
      environment: env.name,
      ...changed,
      localUpdated: Boolean(nextLocal),
      warnings: nextLocal ? plaintextWarnings(ctx.root, env.file) : [],
    };
  } finally {
    plaintext.fill(0);
    localBefore?.fill(0);
  }
}

/**
 * Key-level comparison of vault vs local. Returns key names only.
 * `identical` is true only when both files are byte-for-byte equal (comments and formatting included).
 */
export function diffEnvironment(ctx, name, password) {
  assertPasswordProvided(password);
  const env = resolveEnvironment(ctx, name);
  const envelope = loadEnvelope(ctx, env);
  const plaintext = decryptOrFail(envelope, password, env);

  const localExists = fileExists(env.plainPath);
  let local = null;
  let vaultVars;
  let localVars = {};
  let identical = false;
  try {
    if (localExists) local = safeReadFile(ctx.root, env.plainPath);
    vaultVars = parseEnv(plaintext);
    if (local) {
      localVars = parseEnv(local);
      identical = buffersEqual(local, plaintext);
      if (identical) markSynced(ctx, env, plaintext);
    }
  } finally {
    plaintext.fill(0);
    local?.fill(0);
  }
  return { environment: env.name, localExists, identical, diff: diffEnv(vaultVars, localVars) };
}

/**
 * Creates .dotcrypt.json in root and protects plaintext files in .gitignore.
 * @throws {ConfirmationRequiredError} when a config already exists and overwrite is false.
 */
export function initVault(root, { name, environments, defaultEnvironment, overwrite = false } = {}) {
  if (fs.existsSync(path.join(root, CONFIG_FILENAME)) && !overwrite) {
    throw new ConfirmationRequiredError(`${CONFIG_FILENAME} already exists. Overwrite it?`, { reason: 'config-exists' });
  }
  const config = createConfig({ name: name ?? path.basename(root), environments, defaultEnvironment });
  saveConfig(root, config);

  const plaintextFiles = Object.values(config.environments).map((env) => env.file);
  const gitignoreAdded = ensureGitignore(root, plaintextFiles);
  const warnings = ['.env', ...plaintextFiles]
    .filter((file) => fs.existsSync(path.join(root, file)))
    .flatMap((file) => plaintextWarnings(root, file));
  return { config, gitignoreAdded, warnings };
}

export function addEnvironment(ctx, { name, file, encryptedFile } = {}) {
  if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name)) {
    throw new VaultError('Environment name must be 1-64 letters, digits, "-" or "_", starting and ending alphanumeric.', {
      code: 'INVALID_INPUT',
    });
  }
  if (Object.hasOwn(ctx.config.environments, name)) {
    throw new VaultError(`Environment "${name}" already exists.`, { code: 'INVALID_INPUT' });
  }
  const defaults = defaultFileMapping(name);
  const mapping = { file: file || defaults.file, encryptedFile: encryptedFile || defaults.encryptedFile };
  const config = { ...ctx.config, environments: { ...ctx.config.environments, [name]: mapping } };
  saveConfig(ctx.root, config);
  const gitignoreAdded = ensureGitignore(ctx.root, [mapping.file]);
  return { config, gitignoreAdded };
}

export function setDefaultEnvironment(ctx, name) {
  resolveEnvironment(ctx, name);
  const config = { ...ctx.config, defaultEnvironment: name };
  saveConfig(ctx.root, config);
  return { config };
}

export function repairGitignore(ctx, { dryRun = false } = {}) {
  const files = Object.values(ctx.config.environments).map((env) => env.file);
  return { gitignoreAdded: ensureGitignore(ctx.root, files, { dryRun }) };
}
