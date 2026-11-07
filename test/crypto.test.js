import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecryptionError, EnvelopeFormatError, decrypt, encrypt, parseEnvelope, serializeEnvelope } from '../src/crypto.js';

const PASSWORD = 'correct horse battery staple';
const META = { environment: 'development', sourceFile: '.env.development' };

test('round-trips plaintext and uses a fresh salt and IV each time', () => {
  const a = encrypt('API_KEY=secret\n', PASSWORD, META);
  const b = encrypt('API_KEY=secret\n', PASSWORD, META);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.equal(Buffer.from(a.iv, 'base64').length, 16);
  assert.equal(decrypt(parseEnvelope(serializeEnvelope(a)), PASSWORD).toString(), 'API_KEY=secret\n');
});

test('wrong password raises DecryptionError', () => {
  const env = encrypt('A=1', PASSWORD, META);
  assert.throws(() => decrypt(env, 'wrong password!!'), DecryptionError);
});

test('tampering with ciphertext, tag, or authenticated metadata is detected', () => {
  const env = encrypt('A=1', PASSWORD, META);
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] ^= 1;
    return buf.toString('base64');
  };
  assert.throws(() => decrypt({ ...env, ciphertext: flip(env.ciphertext) }, PASSWORD), DecryptionError);
  assert.throws(() => decrypt({ ...env, authTag: flip(env.authTag) }, PASSWORD), DecryptionError);
  assert.throws(
    () => decrypt({ ...env, metadata: { ...env.metadata, environment: 'production' } }, PASSWORD),
    DecryptionError,
  );
});

test('rejects decrypting a file into a different environment', () => {
  const env = encrypt('A=1', PASSWORD, META);
  assert.throws(() => decrypt(env, PASSWORD, { expectedEnvironment: 'production' }), /belongs to environment/);
});

test('rejects KDF downgrade, malformed fields, and wrong IV length', () => {
  const env = encrypt('A=1', PASSWORD, META);
  assert.throws(() => decrypt({ ...env, kdf: { ...env.kdf, N: 1024 } }, PASSWORD), EnvelopeFormatError);
  assert.throws(() => decrypt({ ...env, iv: Buffer.alloc(12).toString('base64') }, PASSWORD), EnvelopeFormatError);
  assert.throws(() => decrypt({ ...env, authTag: 'not base64!' }, PASSWORD), EnvelopeFormatError);
  assert.throws(() => parseEnvelope('{oops'), EnvelopeFormatError);
});
