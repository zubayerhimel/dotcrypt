import fs from 'node:fs';
import path from 'node:path';
import { VaultError, resolveInside, safeReadFile, safeWriteFile } from './utils.js';

export const CONFIG_FILENAME = '.env-vault.json';
export const CONFIG_VERSION = 1;
export const DEFAULT_ENVIRONMENTS = Object.freeze(['development', 'staging', 'production']);
export const ENV_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i;
const MAX_CONFIG_SIZE = 256 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRelative(value) {
  return path.posix.normalize(value.replace(/\\/g, '/'));
}

function relativePathProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
  if (value.includes('\0')) return 'must not contain null bytes';
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    return 'must be a path relative to the project root';
  }
  const normalized = normalizeRelative(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return 'must stay inside the project directory';
  }
  if (normalized.endsWith('/')) return 'must point to a file, not a directory';
  return null;
}

export function defaultFileMapping(envName) {
  return { file: `.env.${envName}`, encryptedFile: `.env.${envName}.enc` };
}

/**
 * Validates a parsed .env-vault.json, collecting every problem into one error.
 */
export function validateConfig(config) {
  if (!isPlainObject(config)) throw new VaultError(`${CONFIG_FILENAME} must contain a JSON object.`);
  const errors = [];

  if (config.version !== CONFIG_VERSION) errors.push(`"version" must be ${CONFIG_VERSION}`);
  if (!isPlainObject(config.vault) || typeof config.vault.name !== 'string' || !config.vault.name.trim()) {
    errors.push('"vault.name" must be a non-empty string');
  }

  const envs = config.environments;
  if (!isPlainObject(envs) || Object.keys(envs).length === 0) {
    errors.push('"environments" must be an object containing at least one environment');
  } else {
    // Case-insensitive to stay safe on case-insensitive filesystems (Windows/macOS).
    const usedPaths = new Map();
    for (const [name, mapping] of Object.entries(envs)) {
      const where = `environments.${name}`;
      if (!ENV_NAME_PATTERN.test(name)) {
        errors.push(`"${where}": name must be 1-64 chars of letters, digits, "-" or "_", starting and ending alphanumeric`);
        continue;
      }
      if (!isPlainObject(mapping)) {
        errors.push(`"${where}" must be an object with "file" and "encryptedFile"`);
        continue;
      }
      for (const field of ['file', 'encryptedFile']) {
        const value = mapping[field];
        const problem = relativePathProblem(value);
        if (problem) {
          errors.push(`"${where}.${field}" ${problem}`);
          continue;
        }
        const key = normalizeRelative(value).toLowerCase();
        if (usedPaths.has(key)) errors.push(`"${where}.${field}" (${value}) is already used by "${usedPaths.get(key)}"`);
        else usedPaths.set(key, `${where}.${field}`);
      }
      if (typeof mapping.file === 'string' && mapping.file.toLowerCase().endsWith('.enc')) {
        errors.push(`"${where}.file" must be the plaintext file and must not end with ".enc"`);
      }
      if (typeof mapping.encryptedFile === 'string' && !mapping.encryptedFile.endsWith('.enc')) {
        errors.push(`"${where}.encryptedFile" must end with ".enc"`);
      }
    }
  }

  if (config.defaultEnvironment !== undefined) {
    if (!isPlainObject(envs) || typeof config.defaultEnvironment !== 'string' || !Object.hasOwn(envs, config.defaultEnvironment)) {
      errors.push('"defaultEnvironment" must name one of the configured environments');
    }
  }

  if (errors.length > 0) {
    throw new VaultError(`Invalid ${CONFIG_FILENAME}:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}

export function createConfig({ name, environments = DEFAULT_ENVIRONMENTS, defaultEnvironment } = {}) {
  const unique = [...new Set(environments.map((env) => env.trim()).filter(Boolean))];
  const config = {
    version: CONFIG_VERSION,
    vault: {
      name,
      createdAt: new Date().toISOString(),
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
    },
    defaultEnvironment: defaultEnvironment ?? (unique.includes('development') ? 'development' : unique[0]),
    environments: Object.fromEntries(unique.map((env) => [env, defaultFileMapping(env)])),
  };
  return validateConfig(config);
}

/** Walks up from startDir to find the directory containing .env-vault.json. */
export function findProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(startDir = process.cwd()) {
  const root = findProjectRoot(startDir);
  if (!root) {
    throw new VaultError(`No ${CONFIG_FILENAME} found in ${path.resolve(startDir)} or any parent directory.`, {
      code: 'NO_CONFIG',
      hint: 'Run "dotenv-vault-cli init" at the root of your project.',
    });
  }
  const configPath = path.join(root, CONFIG_FILENAME);
  const raw = safeReadFile(root, configPath, { maxSize: MAX_CONFIG_SIZE });
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new VaultError(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
  }
  return { root, configPath, config: validateConfig(parsed) };
}

export function saveConfig(root, config) {
  validateConfig(config);
  safeWriteFile(root, path.join(root, CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
}

export function listEnvironments(config) {
  return Object.keys(config.environments);
}

export function resolveEnvironment({ root, config }, name) {
  if (!Object.hasOwn(config.environments, name)) {
    throw new VaultError(`Unknown environment "${name}".`, {
      code: 'NOT_FOUND',
      hint: `Available environments: ${listEnvironments(config).join(', ')}`,
    });
  }
  const mapping = config.environments[name];
  return {
    name,
    file: mapping.file,
    encryptedFile: mapping.encryptedFile,
    plainPath: resolveInside(root, mapping.file),
    encPath: resolveInside(root, mapping.encryptedFile),
  };
}
