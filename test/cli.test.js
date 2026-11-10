import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const PASSWORD = 'correct horse battery';

function cli(cwd, args, password) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOTCRYPT_PASSWORD: password, NO_COLOR: '1' },
  });
}

test('encrypt --force never re-keys a vault protected by a different password; --replace does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-cli-'));
  assert.equal(cli(root, ['init', '-y', '--envs', 'development'], PASSWORD).status, 0);
  fs.writeFileSync(path.join(root, '.env.development'), 'A=1\n');
  assert.equal(cli(root, ['encrypt'], PASSWORD).status, 0);
  const encPath = path.join(root, '.env.development.enc');
  const original = fs.readFileSync(encPath, 'utf8');

  const forced = cli(root, ['encrypt', '--force'], 'correct horse batteyr');
  assert.equal(forced.status, 2);
  assert.match(forced.stderr, /--replace/);
  assert.equal(fs.readFileSync(encPath, 'utf8'), original);

  assert.equal(cli(root, ['encrypt', '--replace'], 'correct horse batteyr').status, 1);
  assert.equal(fs.readFileSync(encPath, 'utf8'), original);

  assert.equal(cli(root, ['encrypt', '--replace', '--force'], 'a brand new password').status, 0);
  assert.equal(cli(root, ['decrypt', '--force'], 'a brand new password').status, 0);
});

test('init rejects invalid environment names with a clear message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-cli-'));
  const res = cli(root, ['init', '-y', '--envs', 'dev,my env'], PASSWORD);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Invalid environment name\(s\): "my env"/);
  assert.equal(fs.existsSync(path.join(root, '.dotcrypt.json')), false);
});
