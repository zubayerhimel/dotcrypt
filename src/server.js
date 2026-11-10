import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILENAME, DEFAULT_ENVIRONMENTS, findProjectRoot, loadConfig } from './config.js';
import { ConfirmationRequiredError, VaultError, isWithin } from './utils.js';
import * as vault from './vault.js';

export const UI_DIST_DIR = fileURLToPath(new URL('../ui/dist/', import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;

export function isUiBuilt() {
  return fs.existsSync(path.join(UI_DIST_DIR, 'index.html'));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const ERROR_STATUS = {
  NO_CONFIG: 404,
  NOT_FOUND: 404,
  DECRYPT_FAILED: 422,
  INVALID_VAULT: 422,
  WEAK_PASSWORD: 400,
  INVALID_INPUT: 400,
  CONFIRMATION_REQUIRED: 409,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function readJsonBody(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return Promise.reject(new HttpError(415, 'Content-Type must be application/json.'));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      try {
        const parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Request body must be a JSON object.'));
      } finally {
        raw.fill(0); // body may contain passwords
      }
    });
    req.on('error', reject);
  });
}

function errorResponse(err) {
  if (err instanceof ConfirmationRequiredError) {
    return [409, { code: err.code, message: err.message, reason: err.reason, diff: err.diff, hint: err.hint }];
  }
  if (err instanceof VaultError) {
    return [ERROR_STATUS[err.code] ?? 400, { code: err.code, message: err.message, hint: err.hint }];
  }
  if (err instanceof HttpError) return [err.status, { code: 'HTTP_ERROR', message: err.message }];
  return [500, { code: 'INTERNAL_ERROR', message: 'Unexpected server error. See the terminal for details.' }];
}

const bool = (value) => value === true;
const str = (value) => (typeof value === 'string' ? value : undefined);

/** Opens a URL in the default browser without going through a shell. */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = execFile(cmd, args, { windowsHide: true }, () => {});
  child.on('error', () => {});
  child.unref?.();
}

/**
 * Starts the local dashboard server bound to 127.0.0.1.
 *
 * Security model:
 *  - Loopback-only listener; Host header allow-list blocks DNS-rebinding attacks.
 *  - Every API call needs a random per-session bearer token (constant-time compare).
 *  - Mutations require JSON + same-origin, so other websites cannot forge requests.
 *  - Responses never contain secret values; passwords are never logged.
 */
export function startUiServer({ cwd = process.cwd(), port = 0, onLog = () => {} } = {}) {
  const projectDir = findProjectRoot(cwd) ?? path.resolve(cwd);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token, 'utf8');
  const allowedHosts = new Set();

  const hasConfig = () => fs.existsSync(path.join(projectDir, CONFIG_FILENAME));
  const context = () => {
    const ctx = loadConfig(projectDir);
    if (ctx.root !== projectDir) throw new VaultError(`No ${CONFIG_FILENAME} in ${projectDir}.`, { code: 'NO_CONFIG' });
    return ctx;
  };

  const isAuthorized = (req) => {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
    return Boolean(match) && crypto.timingSafeEqual(Buffer.from(match[1], 'utf8'), tokenBytes);
  };

  const isSameOrigin = (req) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  };

  const envActions = {
    encrypt: (ctx, name, body) =>
      vault.encryptEnvironment(ctx, name, str(body.password), {
        overwrite: bool(body.overwrite),
        replaceExisting: bool(body.replaceExisting),
      }),
    decrypt: (ctx, name, body) => vault.decryptEnvironment(ctx, name, str(body.password), { overwrite: bool(body.overwrite) }),
    diff: (ctx, name, body) => vault.diffEnvironment(ctx, name, str(body.password)),
    rotate: (ctx, name, body) => vault.rotateEnvironmentKey(ctx, name, str(body.oldPassword), str(body.newPassword)),
    default: (ctx, name) => {
      vault.setDefaultEnvironment(ctx, name);
      return { status: 'ok', environment: name };
    },
  };

  async function handleApi(req, res, pathname) {
    if (!isAuthorized(req)) throw new HttpError(401, 'Invalid or missing session token. Reopen the URL printed in the terminal.');

    if (req.method === 'GET' && pathname === '/api/status') {
      if (!hasConfig()) {
        return {
          initialized: false,
          root: projectDir,
          configFile: CONFIG_FILENAME,
          suggestedName: path.basename(projectDir),
          defaultEnvironments: DEFAULT_ENVIRONMENTS,
        };
      }
      const ctx = context();
      return {
        initialized: true,
        ...vault.getVaultStatus(ctx),
        gitignoreMissing: vault.repairGitignore(ctx, { dryRun: true }).gitignoreAdded,
      };
    }

    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (!isSameOrigin(req)) throw new HttpError(403, 'Cross-origin requests are not allowed.');
    const body = await readJsonBody(req);

    if (pathname === '/api/init') {
      const environments = Array.isArray(body.environments) ? body.environments.filter((e) => typeof e === 'string') : undefined;
      const result = vault.initVault(projectDir, {
        name: str(body.name),
        environments,
        defaultEnvironment: str(body.defaultEnvironment),
        overwrite: bool(body.overwrite),
      });
      onLog(`init: created ${CONFIG_FILENAME}`);
      return { status: 'created', gitignoreAdded: result.gitignoreAdded, warnings: result.warnings };
    }
    if (pathname === '/api/environments') {
      const result = vault.addEnvironment(context(), {
        name: str(body.name),
        file: str(body.file),
        encryptedFile: str(body.encryptedFile),
      });
      onLog(`add environment: ${body.name}`);
      return { status: 'created', gitignoreAdded: result.gitignoreAdded };
    }
    if (pathname === '/api/gitignore') {
      const result = vault.repairGitignore(context());
      onLog('.gitignore repaired');
      return result;
    }

    const match = /^\/api\/environments\/([^/]+)\/([a-z]+)$/.exec(pathname);
    if (match && Object.hasOwn(envActions, match[2])) {
      const name = decodeURIComponent(match[1]);
      const action = match[2];
      const result = envActions[action](context(), name, body);
      onLog(`${action} ${name}: ${result.status ?? 'ok'}`);
      return result;
    }
    throw new HttpError(404, 'Not found.');
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    let file = path.resolve(UI_DIST_DIR, `.${decoded}`);
    if (!isWithin(UI_DIST_DIR, file)) return send(res, 404, 'Not found');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(UI_DIST_DIR, 'index.html');
    if (!fs.existsSync(file)) {
      return send(res, 503, 'Dashboard assets are not built. Run "npm run build:ui" in the dotcrypt package.', {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }

    const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = decoded.startsWith('/assets/');
    send(res, 200, req.method === 'HEAD' ? undefined : fs.readFileSync(file), {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, 'Misdirected request');
      const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        try {
          sendJson(res, 200, await handleApi(req, res, pathname));
        } catch (err) {
          const [status, payload] = errorResponse(err);
          if (status === 500) onLog(`error: ${err.stack ?? err.message}`);
          sendJson(res, status, { error: payload });
        }
        return undefined;
      }
      return serveStatic(req, res, pathname);
    } catch (err) {
      onLog(`error: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'Internal error');
      return undefined;
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      allowedHosts.add(`127.0.0.1:${actualPort}`);
      allowedHosts.add(`localhost:${actualPort}`);
      resolve({
        server,
        port: actualPort,
        projectDir,
        token,
        url: `http://127.0.0.1:${actualPort}/?token=${token}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
