import crypto from 'node:crypto';

export const FORMAT_VERSION = 1;
export const ALGORITHM = 'aes-256-gcm';
export const KDF_NAME = 'scrypt';
export const KEY_LENGTH = 32; // 256-bit key
export const IV_LENGTH = 16;
export const SALT_LENGTH = 32;
export const MIN_SALT_LENGTH = 16;
export const AUTH_TAG_LENGTH = 16;

// N=2^15, r=8 => ~32 MiB of memory per derivation (OWASP-recommended baseline).
export const DEFAULT_SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });

// Bounds applied to parameters read from (untrusted) encrypted files: the lower
// bounds prevent KDF downgrade attacks, the upper bounds prevent memory/CPU DoS.
const SCRYPT_BOUNDS = Object.freeze({ minN: 2 ** 14, maxN: 2 ** 20, minR: 8, maxR: 32, minP: 1, maxP: 16 });
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;

const ENV_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class DecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class EnvelopeFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvelopeFormatError';
  }
}

function scryptMemory({ N, r, p }) {
  return 128 * N * r + 128 * r * p;
}

export function validateScryptParams(params) {
  const { N, r, p } = params ?? {};
  if (![N, r, p].every(Number.isSafeInteger)) {
    throw new EnvelopeFormatError('scrypt parameters N, r and p must be integers.');
  }
  if (N < SCRYPT_BOUNDS.minN || N > SCRYPT_BOUNDS.maxN || (N & (N - 1)) !== 0) {
    throw new EnvelopeFormatError(
      `scrypt N must be a power of two between ${SCRYPT_BOUNDS.minN} and ${SCRYPT_BOUNDS.maxN}.`,
    );
  }
  if (r < SCRYPT_BOUNDS.minR || r > SCRYPT_BOUNDS.maxR) {
    throw new EnvelopeFormatError(`scrypt r must be between ${SCRYPT_BOUNDS.minR} and ${SCRYPT_BOUNDS.maxR}.`);
  }
  if (p < SCRYPT_BOUNDS.minP || p > SCRYPT_BOUNDS.maxP) {
    throw new EnvelopeFormatError(`scrypt p must be between ${SCRYPT_BOUNDS.minP} and ${SCRYPT_BOUNDS.maxP}.`);
  }
  if (scryptMemory({ N, r, p }) > MAX_SCRYPT_MEMORY) {
    throw new EnvelopeFormatError('scrypt parameters exceed the allowed memory budget.');
  }
  return { N, r, p };
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string.');
  }
}

/**
 * Derives a 256-bit key from a password using scrypt.
 * The password is NFC-normalized so the same visual password yields the same key
 * on every OS / keyboard layout.
 */
export function deriveKey(password, salt, params = DEFAULT_SCRYPT_PARAMS) {
  assertPassword(password);
  if (!Buffer.isBuffer(salt) || salt.length < MIN_SALT_LENGTH) {
    throw new TypeError(`Salt must be a Buffer of at least ${MIN_SALT_LENGTH} bytes.`);
  }
  const { N, r, p } = validateScryptParams(params);
  const passwordBytes = Buffer.from(password.normalize('NFC'), 'utf8');
  try {
    return crypto.scryptSync(passwordBytes, salt, KEY_LENGTH, {
      N,
      r,
      p,
      maxmem: scryptMemory({ N, r, p }) + 16 * 1024 * 1024,
    });
  } finally {
    passwordBytes.fill(0);
  }
}

/**
 * Additional Authenticated Data: binds every header field (format, KDF params,
 * salt, IV, environment metadata) to the ciphertext so none of it can be
 * altered, downgraded, or swapped between environments without detection.
 */
function buildAad(header) {
  return Buffer.from(
    JSON.stringify([
      'dotenv-vault-cli',
      header.version,
      header.algorithm,
      header.kdf.name,
      header.kdf.N,
      header.kdf.r,
      header.kdf.p,
      header.kdf.salt,
      header.iv,
      header.metadata.environment,
      header.metadata.sourceFile,
      header.metadata.encryptedAt,
    ]),
    'utf8',
  );
}

function decodeBase64(value, field) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw new EnvelopeFormatError(`"${field}" must be a valid base64 string.`);
  }
  return Buffer.from(value, 'base64');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strictly validates an envelope object and returns its decoded binary fields.
 */
export function validateEnvelope(envelope) {
  if (!isPlainObject(envelope)) throw new EnvelopeFormatError('Encrypted file must contain a JSON object.');
  if (envelope.version !== FORMAT_VERSION) {
    throw new EnvelopeFormatError(`Unsupported format version: ${JSON.stringify(envelope.version)}.`);
  }
  if (envelope.algorithm !== ALGORITHM) {
    throw new EnvelopeFormatError(`Unsupported algorithm: ${JSON.stringify(envelope.algorithm)}.`);
  }
  if (!isPlainObject(envelope.kdf) || envelope.kdf.name !== KDF_NAME) {
    throw new EnvelopeFormatError('Unsupported or missing key derivation function.');
  }
  validateScryptParams(envelope.kdf);

  const meta = envelope.metadata;
  if (!isPlainObject(meta)) throw new EnvelopeFormatError('Missing "metadata" object.');
  if (typeof meta.environment !== 'string' || !ENV_NAME_PATTERN.test(meta.environment)) {
    throw new EnvelopeFormatError('"metadata.environment" is missing or invalid.');
  }
  if (typeof meta.sourceFile !== 'string' || typeof meta.encryptedAt !== 'string') {
    throw new EnvelopeFormatError('"metadata.sourceFile" and "metadata.encryptedAt" must be strings.');
  }

  const salt = decodeBase64(envelope.kdf.salt, 'kdf.salt');
  const iv = decodeBase64(envelope.iv, 'iv');
  const authTag = decodeBase64(envelope.authTag, 'authTag');
  const ciphertext = decodeBase64(envelope.ciphertext, 'ciphertext');

  if (salt.length < MIN_SALT_LENGTH || salt.length > 64) {
    throw new EnvelopeFormatError(`Salt must be between ${MIN_SALT_LENGTH} and 64 bytes.`);
  }
  if (iv.length !== IV_LENGTH) throw new EnvelopeFormatError(`IV must be exactly ${IV_LENGTH} bytes.`);
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new EnvelopeFormatError(`Authentication tag must be exactly ${AUTH_TAG_LENGTH} bytes.`);
  }
  return { salt, iv, authTag, ciphertext };
}

/**
 * Encrypts plaintext with AES-256-GCM using a fresh random salt and IV per call.
 * @returns {object} JSON-serializable envelope.
 */
export function encrypt(plaintext, password, { environment, sourceFile, scryptParams = DEFAULT_SCRYPT_PARAMS } = {}) {
  assertPassword(password);
  if (typeof environment !== 'string' || !ENV_NAME_PATTERN.test(environment)) {
    throw new TypeError('A valid environment name is required.');
  }
  if (typeof sourceFile !== 'string' || sourceFile.length === 0) {
    throw new TypeError('sourceFile is required.');
  }
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const { N, r, p } = validateScryptParams(scryptParams);

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const header = {
    version: FORMAT_VERSION,
    algorithm: ALGORITHM,
    kdf: { name: KDF_NAME, N, r, p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    metadata: { environment, sourceFile, encryptedAt: new Date().toISOString() },
  };

  const key = deriveKey(password, salt, { N, r, p });
  try {
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(buildAad(header));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return {
      ...header,
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypts and authenticates an envelope.
 * @throws {DecryptionError} on wrong password, tampering, or environment mismatch.
 * @returns {Buffer} plaintext (caller should zero it when done).
 */
export function decrypt(envelope, password, { expectedEnvironment } = {}) {
  assertPassword(password);
  const { salt, iv, authTag, ciphertext } = validateEnvelope(envelope);
  const key = deriveKey(password, salt, envelope.kdf);

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(buildAad(envelope));
    decipher.setAuthTag(authTag);
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // GCM cannot (and must not) distinguish a wrong key from tampered data.
      throw new DecryptionError(
        'Decryption failed: the password is incorrect, or the encrypted file is corrupted or has been tampered with.',
      );
    }
  } finally {
    key.fill(0);
  }

  if (expectedEnvironment !== undefined && envelope.metadata.environment !== expectedEnvironment) {
    plaintext.fill(0);
    throw new DecryptionError(
      `Encrypted file belongs to environment "${envelope.metadata.environment}", expected "${expectedEnvironment}".`,
    );
  }
  return plaintext;
}

export function serializeEnvelope(envelope) {
  validateEnvelope(envelope);
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseEnvelope(text) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : text);
  } catch (err) {
    throw new EnvelopeFormatError(`Encrypted file is not valid JSON (${err.message}).`);
  }
  validateEnvelope(parsed);
  return parsed;
}
