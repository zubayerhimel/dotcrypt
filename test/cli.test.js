import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const PASSWORD = 'correct horse battery';

function cli(cwd, args, password, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOTCRYPT_PASSWORD: password, NO_COLOR: '1', ...extraEnv },
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

test('run injects vault variables into the command without writing plaintext or leaking the password', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-cli-'));
  assert.equal(cli(root, ['init', '-y', '--envs', 'development'], PASSWORD).status, 0);
  const plain = path.join(root, '.env.development');
  fs.writeFileSync(plain, 'A=from-vault\nB=vault-b\n');
  assert.equal(cli(root, ['encrypt'], PASSWORD).status, 0);
  fs.rmSync(plain);

  const script = 'process.stdout.write([process.env.A, process.env.B, process.env.DOTCRYPT_PASSWORD ?? "none"].join("|"))';
  const res = cli(root, ['run', '--', process.execPath, '-e', script], PASSWORD, { B: 'from-shell' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'from-vault|from-shell|none');
  assert.match(res.stderr, /1 already set in your shell/);
  assert.equal(fs.existsSync(plain), false);

  const overridden = cli(root, ['run', '--override', '-q', '--', process.execPath, '-e', script], PASSWORD, { B: 'x' });
  assert.equal(overridden.stdout, 'from-vault|vault-b|none');
  assert.equal(overridden.stderr, '');

  assert.equal(cli(root, ['run', process.execPath, '-e', 'process.exit(7)'], PASSWORD).status, 7);
  assert.equal(cli(root, ['run', 'dotcrypt-no-such-command'], PASSWORD).status, 127);
  assert.equal(cli(root, ['run', process.execPath, '-e', '1'], 'wrong password!!').status, 2);
});

test('set, get and unset edit single variables in the vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-cli-'));
  assert.equal(cli(root, ['init', '-y', '--envs', 'development'], PASSWORD).status, 0);
  fs.writeFileSync(path.join(root, '.env.development'), 'A=1\n');
  assert.equal(cli(root, ['encrypt'], PASSWORD).status, 0);

  const set = cli(root, ['set', 'URL=https://x.dev/?a=1&b=2', 'B=two words'], PASSWORD);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout + set.stderr, /git add/);

  const piped = spawnSync(process.execPath, [CLI, 'set', 'SECRET'], {
    cwd: root,
    encoding: 'utf8',
    input: 's3cr3t "quoted"\n',
    env: { ...process.env, DOTCRYPT_PASSWORD: PASSWORD, NO_COLOR: '1' },
  });
  assert.equal(piped.status, 0, piped.stderr);
  assert.doesNotMatch(piped.stdout + piped.stderr, /s3cr3t/);

  assert.equal(cli(root, ['get', 'URL'], PASSWORD).stdout, 'https://x.dev/?a=1&b=2');
  assert.equal(cli(root, ['get', 'SECRET'], PASSWORD).stdout, 's3cr3t "quoted"');
  assert.equal(cli(root, ['get', 'SECRET'], 'wrong password').status, 2);

  assert.equal(cli(root, ['unset', 'B'], PASSWORD).status, 0);
  assert.equal(cli(root, ['get', 'B'], PASSWORD).status, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.env.development'), 'utf8'), /^B=/m);
  assert.equal(cli(root, ['set', '1BAD=x'], PASSWORD).status, 1);
});
