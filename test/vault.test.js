import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { ConfirmationRequiredError } from '../src/utils.js';
import { decryptEnvironment, encryptEnvironment, initVault, rotateEnvironmentKey } from '../src/vault.js';

const PASSWORD = 'correct horse battery';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-vault-'));
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
