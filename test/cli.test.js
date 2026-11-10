import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const PASSWORD = 'correct horse battery';

// A FORCE_COLOR from the developer's terminal would override NO_COLOR and add color codes to the output.
const { FORCE_COLOR, ...baseEnv } = process.env;
const childEnv = (extra = {}) => ({ ...baseEnv, NO_COLOR: '1', ...extra });

function cli(cwd, args, password, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ DOTCRYPT_PASSWORD: password, ...extraEnv }),
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
    env: childEnv({ DOTCRYPT_PASSWORD: PASSWORD }),
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

test('hooks block plaintext commits, keep existing hooks and announce incoming changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-cli-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-bin-'));
  fs.writeFileSync(path.join(binDir, 'dotcrypt'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: childEnv(env),
    });

  git('init', '-q');
  const preCommit = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(preCommit, '#!/bin/sh\necho existing-hook-ran\n', { mode: 0o755 });
  assert.equal(cli(root, ['init', '-y', '--envs', 'development'], PASSWORD).status, 0);
  fs.writeFileSync(path.join(root, '.env.development'), 'A=1\n');
  assert.equal(cli(root, ['encrypt'], PASSWORD).status, 0);
  assert.equal(cli(root, ['hooks', 'install'], PASSWORD).status, 0);
  assert.equal(cli(root, ['hooks', 'install'], PASSWORD).status, 0);
  assert.equal(fs.readFileSync(preCommit, 'utf8').match(/>>> dotcrypt >>>/g).length, 1);

  git('add', '.gitignore', '.dotcrypt.json', '.env.development.enc');
  git('add', '-f', '.env.development');
  const blocked = git('commit', '-m', 'oops');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /blocked this commit[\s\S]*\.env\.development/);

  git('rm', '-q', '--cached', '.env.development');
  fs.appendFileSync(path.join(root, '.env.development'), 'B=2\n');
  const ok = git('commit', '-m', 'share');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout + ok.stderr, /existing-hook-ran/);
  assert.match(ok.stderr, /development has changes you have not shared/);

  // Another branch changes the vault; switching to it announces the incoming change.
  assert.equal(cli(root, ['encrypt', '--force'], PASSWORD).status, 0);
  git('checkout', '-q', '-b', 'teammate');
  git('commit', '-qam', 'teammate change');
  git('checkout', '-q', '-');
  assert.equal(cli(root, ['decrypt', '--force'], PASSWORD).status, 0);
  const back = git('checkout', 'teammate');
  assert.match(back.stderr, /new secrets from your team in development\. Run: dotcrypt decrypt -e development/);

  assert.equal(cli(root, ['hooks', 'uninstall'], PASSWORD).status, 0);
  assert.equal(fs.readFileSync(preCommit, 'utf8'), '#!/bin/sh\necho existing-hook-ran\n');
  assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'post-merge')), false);
});

test('check lists variables missing from some environments without printing values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-cli-'));
  assert.equal(cli(root, ['init', '-y', '--envs', 'development,staging,production'], PASSWORD).status, 0);
  fs.writeFileSync(path.join(root, '.env.development'), 'A=1\nB=secret-b\nNEW=1\n');
  fs.writeFileSync(path.join(root, '.env.staging'), 'A=1\nB=2\n');
  fs.writeFileSync(path.join(root, '.env.production'), 'A=1\n');
  for (const env of ['development', 'staging']) assert.equal(cli(root, ['encrypt', '-e', env], PASSWORD).status, 0);
  assert.equal(cli(root, ['encrypt', '-e', 'production'], 'another long password').status, 0);

  const res = cli(root, ['check'], PASSWORD);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /Skipped production: wrong password/);
  assert.match(res.stdout, /NEW\s+missing in staging/);
  assert.doesNotMatch(res.stdout + res.stderr, /secret-b/);

  assert.equal(cli(root, ['set', 'NEW=1', '-e', 'staging'], PASSWORD).status, 0);
  const ok = cli(root, ['check', '-e', 'development,staging'], PASSWORD);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /All 3 variables exist in every environment/);
});
