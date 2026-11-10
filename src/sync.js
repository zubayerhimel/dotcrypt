import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MAX_FILE_SIZE, gitOutput } from './utils.js';

/**
 * Remembers, per machine, the fingerprints of the local env file and the vault file at the moment
 * they were last known to match (after encrypt, decrypt, or an identical diff). Comparing the
 * current files against that baseline tells us who changed what, without needing the password:
 *
 *   local changed only  -> you have changes to share
 *   vault changed only  -> a teammate shared changes (after git pull)
 *   both changed        -> conflict
 *
 * The state lives inside the Git directory (.git/dotcrypt/sync-state.json), so it is never
 * committed and every clone or worktree tracks its own files.
 */

const STATE_VERSION = 1;

export function fingerprint(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of a file, or null when it is missing, too large or unreadable. */
export function fingerprintFile(absPath) {
  try {
    if (fs.statSync(absPath).size > MAX_FILE_SIZE) return null;
    const data = fs.readFileSync(absPath);
    try {
      return fingerprint(data);
    } finally {
      data.fill(0);
    }
  } catch {
    return null;
  }
}

function locateState(root) {
  const out = gitOutput(root, ['rev-parse', '--absolute-git-dir', '--show-prefix']);
  if (!out) return null;
  const [gitDir, prefix = ''] = out.split('\n');
  if (!gitDir) return null;
  return { file: path.join(gitDir, 'dotcrypt', 'sync-state.json'), project: prefix.replace(/\/$/, '') || '.' };
}

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.version === STATE_VERSION && state.projects && typeof state.projects === 'object') return state;
  } catch {
    // Missing or corrupt state simply means "unknown"; it is rebuilt on the next sync.
  }
  return { version: STATE_VERSION, projects: {} };
}

/** Opens the sync state for a project root. All methods are no-ops outside a Git repository. */
export function openSyncState(root) {
  const location = locateState(root);
  const state = location ? readState(location.file) : null;
  const entries = () => (state ? (state.projects[location.project] ?? {}) : {});

  return {
    get(envName) {
      const entry = Object.hasOwn(entries(), envName) ? entries()[envName] : null;
      return entry && typeof entry.local === 'string' && typeof entry.vault === 'string' ? entry : null;
    },
    set(envName, { local, vault }) {
      if (!state || !local || !vault) return;
      state.projects[location.project] = { ...entries(), [envName]: { local, vault, syncedAt: new Date().toISOString() } };
      try {
        fs.mkdirSync(path.dirname(location.file), { recursive: true });
        const tmp = `${location.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, location.file);
      } catch {
        // Best effort: sync tracking must never make encrypt or decrypt fail.
      }
    },
  };
}

/**
 * Plain-language sync state of one environment:
 * empty | not-shared | not-downloaded | unknown | synced | local-changes | incoming-changes | conflict
 */
export function computeSync({ localExists, vaultExists, localHash, vaultHash, baseline }) {
  if (!localExists && !vaultExists) return 'empty';
  if (!vaultExists) return 'not-shared';
  if (!localExists) return 'not-downloaded';
  if (!baseline || !localHash || !vaultHash) return 'unknown';
  const localChanged = localHash !== baseline.local;
  const vaultChanged = vaultHash !== baseline.vault;
  if (localChanged && vaultChanged) return 'conflict';
  if (localChanged) return 'local-changes';
  if (vaultChanged) return 'incoming-changes';
  return 'synced';
}
