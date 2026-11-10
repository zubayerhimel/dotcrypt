import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadConfig } from '../src/config.js';
import { ConfirmationRequiredError, parseEnv } from '../src/utils.js';
import {
  decryptEnvironment,
  diffEnvironment,
  encryptEnvironment,
  getEnvironmentStatus,
  initVault,
  readEnvironmentVariables,
  rotateEnvironmentKey,
  updateEnvironmentVariables,
} from '../src/vault.js';

const PASSWORD = 'correct horse battery';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-vault-'));
  initVault(root, { name: 'app', environments: ['development'] });
  fs.writeFileSync(path.join(root, '.env.development'), 'A=1\nB=2\n');
  return { root, ctx: loadConfig(root) };
}

function confirmationReason(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfirmationRequiredError, `expected ConfirmationRequiredError, got ${err}`);
    return err;
  }
  assert.fail('expected a confirmation to be required');
}

test('initVault refuses to overwrite an existing config without overwrite', () => {
  const { root } = setup();
  assert.equal(confirmationReason(() => initVault(root, { name: 'x' })).reason, 'config-exists');
});

test('encrypt asks for confirmation with a key diff before overwriting', () => {
  const { root, ctx } = setup();
  assert.equal(encryptEnvironment(ctx, 'development', PASSWORD).status, 'created');
  assert.equal(encryptEnvironment(ctx, 'development', PASSWORD).status, 'unchanged');

  fs.writeFileSync(path.join(root, '.env.development'), 'A=1\nC=3\n');
  const err = confirmationReason(() => encryptEnvironment(ctx, 'development', PASSWORD));
  assert.equal(err.reason, 'overwrite');
  assert.deepEqual(err.diff, { added: ['C'], removed: ['B'], changed: [], unchanged: 1 });

  assert.equal(encryptEnvironment(ctx, 'development', PASSWORD, { overwrite: true }).status, 'updated');
});

test('encrypt with a different password requires replaceExisting', () => {
  const { ctx } = setup();
  encryptEnvironment(ctx, 'development', PASSWORD);
  const err = confirmationReason(() => encryptEnvironment(ctx, 'development', 'another long password'));
  assert.equal(err.reason, 'password-mismatch');
  const result = encryptEnvironment(ctx, 'development', 'another long password', { replaceExisting: true });
  assert.equal(result.status, 'updated');
});

test('encrypt treats a vault file from another environment as unreadable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-vault-'));
  initVault(root, { name: 'app', environments: ['development', 'staging'] });
  fs.writeFileSync(path.join(root, '.env.development'), 'A=1\n');
  fs.writeFileSync(path.join(root, '.env.staging'), 'A=2\n');
  const ctx = loadConfig(root);
  encryptEnvironment(ctx, 'development', PASSWORD);
  fs.copyFileSync(path.join(root, '.env.development.enc'), path.join(root, '.env.staging.enc'));

  const err = confirmationReason(() => encryptEnvironment(ctx, 'staging', PASSWORD));
  assert.equal(err.reason, 'unreadable-vault');
  assert.match(err.message, /belongs to environment "development"/);
});

test('diff reports key-level sync separately from byte-level identity', () => {
  const { root, ctx } = setup();
  encryptEnvironment(ctx, 'development', PASSWORD);
  assert.equal(diffEnvironment(ctx, 'development', PASSWORD).identical, true);

  fs.writeFileSync(path.join(root, '.env.development'), '# note\nA="1"\nB=2\n');
  const { diff, identical } = diffEnvironment(ctx, 'development', PASSWORD);
  assert.equal(identical, false);
  assert.deepEqual(diff, { added: [], removed: [], changed: [], unchanged: 2 });
});

test('decrypt protects a differing local file and restores it on overwrite', () => {
  const { root, ctx } = setup();
  encryptEnvironment(ctx, 'development', PASSWORD);
  const plainPath = path.join(root, '.env.development');
  fs.writeFileSync(plainPath, 'A=changed\n');

  const err = confirmationReason(() => decryptEnvironment(ctx, 'development', PASSWORD));
  assert.deepEqual(err.diff, { added: [], removed: ['B'], changed: ['A'], unchanged: 0 });
  assert.equal(fs.readFileSync(plainPath, 'utf8'), 'A=changed\n');

  decryptEnvironment(ctx, 'development', PASSWORD, { overwrite: true });
  assert.equal(fs.readFileSync(plainPath, 'utf8'), 'A=1\nB=2\n');
});

test('wrong passwords fail with DECRYPT_FAILED and rotation invalidates the old password', () => {
  const { ctx } = setup();
  encryptEnvironment(ctx, 'development', PASSWORD);
  assert.throws(() => decryptEnvironment(ctx, 'development', 'wrong password!!'), { code: 'DECRYPT_FAILED' });

  rotateEnvironmentKey(ctx, 'development', PASSWORD, 'brand new password');
  assert.throws(() => decryptEnvironment(ctx, 'development', PASSWORD, { overwrite: true }), { code: 'DECRYPT_FAILED' });
  assert.equal(decryptEnvironment(ctx, 'development', 'brand new password').status, 'unchanged');
});

function gitSetup() {
  const { root, ctx } = setup();
  execFileSync('git', ['init', '-q'], { cwd: root });
  return { root, ctx };
}

const syncOf = (ctx) => getEnvironmentStatus(ctx, 'development').sync;

test('tracks who changed what since the last sync, per clone', () => {
  const me = gitSetup();
  assert.equal(syncOf(me.ctx), 'not-shared');
  encryptEnvironment(me.ctx, 'development', PASSWORD);
  assert.equal(syncOf(me.ctx), 'synced');

  // A teammate's clone receives the vault file and decrypts it.
  const mate = gitSetup();
  fs.rmSync(path.join(mate.root, '.env.development'));
  fs.copyFileSync(path.join(me.root, '.env.development.enc'), path.join(mate.root, '.env.development.enc'));
  assert.equal(syncOf(mate.ctx), 'not-downloaded');
  decryptEnvironment(mate.ctx, 'development', PASSWORD);
  assert.equal(syncOf(mate.ctx), 'synced');

  // The teammate adds a variable and shares it.
  fs.appendFileSync(path.join(mate.root, '.env.development'), 'C=3\n');
  assert.equal(syncOf(mate.ctx), 'local-changes');
  encryptEnvironment(mate.ctx, 'development', PASSWORD, { overwrite: true });
  assert.equal(syncOf(mate.ctx), 'synced');

  // I pull their vault file: incoming changes; if I also edited locally: conflict.
  fs.copyFileSync(path.join(mate.root, '.env.development.enc'), path.join(me.root, '.env.development.enc'));
  assert.equal(syncOf(me.ctx), 'incoming-changes');
  fs.appendFileSync(path.join(me.root, '.env.development'), 'D=4\n');
  assert.equal(syncOf(me.ctx), 'conflict');
  decryptEnvironment(me.ctx, 'development', PASSWORD, { overwrite: true });
  assert.equal(syncOf(me.ctx), 'synced');

  rotateEnvironmentKey(me.ctx, 'development', PASSWORD, 'brand new password');
  assert.equal(syncOf(me.ctx), 'synced');
});

test('sync state is unknown until a matching diff confirms it', () => {
  const { root, ctx } = gitSetup();
  encryptEnvironment(ctx, 'development', PASSWORD);
  fs.rmSync(path.join(root, '.git', 'dotcrypt'), { recursive: true });
  assert.equal(syncOf(ctx), 'unknown');
  diffEnvironment(ctx, 'development', PASSWORD);
  assert.equal(syncOf(ctx), 'synced');
});

test('updateEnvironmentVariables edits vault and local file in place and keeps them in sync', () => {
  const { root, ctx } = gitSetup();
  const plain = path.join(root, '.env.development');
  fs.writeFileSync(plain, '# database\nexport DB=old\nA=1\nGONE=x\n');
  encryptEnvironment(ctx, 'development', PASSWORD);

  const result = updateEnvironmentVariables(ctx, 'development', PASSWORD, {
    set: { DB: 'postgres://u:p@h/db', NEW: "it's #1\nline two" },
    unset: ['GONE', 'NOPE'],
  });
  assert.deepEqual([result.status, result.set, result.unset, result.missing], ['updated', ['DB', 'NEW'], ['GONE'], ['NOPE']]);
  const local = fs.readFileSync(plain, 'utf8');
  assert.match(local, /^# database\nexport DB=/);
  assert.deepEqual(parseEnv(local), { DB: 'postgres://u:p@h/db', A: '1', NEW: "it's #1\nline two" });
  assert.deepEqual(readEnvironmentVariables(ctx, 'development', PASSWORD), parseEnv(local));
  assert.equal(syncOf(ctx), 'synced');

  assert.equal(updateEnvironmentVariables(ctx, 'development', PASSWORD, { set: { A: '1' } }).status, 'unchanged');

  // Unshared local edits stay visible as local changes after a set.
  fs.appendFileSync(plain, 'MINE=1\n');
  updateEnvironmentVariables(ctx, 'development', PASSWORD, { set: { A: '2' } });
  assert.equal(parseEnv(fs.readFileSync(plain, 'utf8')).MINE, '1');
  assert.equal(readEnvironmentVariables(ctx, 'development', PASSWORD).MINE, undefined);
  assert.equal(syncOf(ctx), 'local-changes');
});
