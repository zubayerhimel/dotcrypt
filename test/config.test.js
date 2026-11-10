import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfig, validateConfig } from '../src/config.js';
import { VaultError, diffEnv, ensureGitignore, resolveInside } from '../src/utils.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dotcrypt-'));
}

test('createConfig maps environments to default files', () => {
  const config = createConfig({ name: 'app', environments: ['development', 'production'] });
  assert.equal(config.defaultEnvironment, 'development');
  assert.deepEqual(config.environments.production, { file: '.env.production', encryptedFile: '.env.production.enc' });
});

test('validateConfig rejects traversal, absolute paths, bad names and duplicates', () => {
  const base = createConfig({ name: 'app', environments: ['development'] });
  const bad = (environments) => () => validateConfig({ ...base, environments, defaultEnvironment: undefined });
  assert.throws(bad({ dev: { file: '../.bashrc', encryptedFile: 'x.enc' } }), VaultError);
  assert.throws(bad({ dev: { file: '/etc/passwd', encryptedFile: 'x.enc' } }), VaultError);
  assert.throws(bad({ '../x': { file: '.env.x', encryptedFile: 'x.enc' } }), VaultError);
  assert.throws(bad({ dev: { file: '.env.dev', encryptedFile: '.env.dev' } }), VaultError);
  assert.throws(
    bad({ a: { file: '.env.a', encryptedFile: 'a.enc' }, b: { file: '.ENV.A', encryptedFile: 'b.enc' } }),
    /already used/,
  );
});

test('resolveInside blocks escaping the project root', () => {
  const root = tmpDir();
  assert.throws(() => resolveInside(root, '../outside'), VaultError);
  assert.equal(resolveInside(root, 'sub/.env'), path.join(root, 'sub', '.env'));
});

test('ensureGitignore appends missing rules once and preserves existing content', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.env\n');
  const added = ensureGitignore(root, ['.env.development', 'config/secrets.env']);
  assert.deepEqual(added, ['.env.*', '!.env.*.enc', '/config/secrets.env']);
  assert.deepEqual(ensureGitignore(root, ['.env.development', 'config/secrets.env']), []);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^node_modules\n\.env\n/);
});

test('diffEnv reports key names only', () => {
  const diff = diffEnv({ A: '1', B: '2', C: '3' }, { A: '1', B: 'x', D: '4' });
  assert.deepEqual(diff, { added: ['D'], removed: ['C'], changed: ['B'], unchanged: 1 });
});
