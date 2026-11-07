import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startUiServer } from '../src/server.js';

let ui;
let root;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-server-'));
  ui = await startUiServer({ cwd: root, onLog: () => {} });
});

after(() => ui.close());

function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: ui.port, method, path: pathname, headers: { Host: `127.0.0.1:${ui.port}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const auth = () => ({ Authorization: `Bearer ${ui.token}` });
const post = (pathname, payload, headers = {}) =>
  request('POST', pathname, {
    headers: { ...auth(), 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

test('binds to loopback and puts the token in the URL', () => {
  assert.equal(ui.server.address().address, '127.0.0.1');
  assert.match(ui.token, /^[0-9a-f]{64}$/);
  assert.ok(ui.url.endsWith(`?token=${ui.token}`));
});

test('rejects foreign Host headers (DNS rebinding)', async () => {
  const res = await request('GET', '/api/status', { headers: { ...auth(), Host: `evil.example:${ui.port}` } });
  assert.equal(res.status, 421);
});

test('requires the session token', async () => {
  assert.equal((await request('GET', '/api/status')).status, 401);
  assert.equal((await request('GET', '/api/status', { headers: { Authorization: 'Bearer nope' } })).status, 401);
});

test('rejects cross-origin and non-JSON writes', async () => {
  assert.equal((await post('/api/init', { name: 'x' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/init', { name: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const form = await request('POST', '/api/init', {
    headers: { ...auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=x',
  });
  assert.equal(form.status, 415);
});

test('initializes, encrypts and reports status without leaking secrets', async () => {
  let res = await request('GET', '/api/status', { headers: auth() });
  assert.equal(res.status, 200);
  assert.equal(res.json.initialized, false);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(res.headers['content-security-policy']);

  res = await post('/api/init', { name: 'app', environments: ['development'] }, { Origin: `http://127.0.0.1:${ui.port}` });
  assert.equal(res.status, 200);

  fs.writeFileSync(path.join(root, '.env.development'), 'SECRET_KEY=super-secret-value\n');
  res = await post('/api/environments/development/encrypt', { password: 'short' });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'WEAK_PASSWORD');

  res = await post('/api/environments/development/encrypt', { password: 'correct horse battery' });
  assert.equal(res.json.status, 'created');

  res = await post('/api/environments/development/decrypt', { password: 'wrong password!!' });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'DECRYPT_FAILED');

  fs.writeFileSync(path.join(root, '.env.development'), 'SECRET_KEY=other-value\n');
  res = await post('/api/environments/development/decrypt', { password: 'correct horse battery' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.reason, 'overwrite');
  assert.deepEqual(res.json.error.diff.changed, ['SECRET_KEY']);

  res = await request('GET', '/api/status', { headers: auth() });
  assert.equal(res.json.environments[0].vault.valid, true);
  assert.ok(!JSON.stringify(res.json).includes('super-secret-value'));
});

test('does not serve files outside the UI bundle', async () => {
  const res = await request('GET', '/..%2f..%2fpackage.json');
  assert.notEqual(res.headers['content-type'], 'application/json; charset=utf-8');
});
