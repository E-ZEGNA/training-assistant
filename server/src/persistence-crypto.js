import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function assertKey(key) {
  const value = Buffer.isBuffer(key) ? key : Buffer.from(key ?? '');
  if (value.length !== 32) throw new Error('Persistence encryption key must be 32 bytes');
  return value;
}

export function encryptJson(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', assertKey(key), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  });
}

export function decryptJson(envelope, key) {
  const value = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (value?.version !== 1 || value?.algorithm !== 'aes-256-gcm') throw new Error('Unsupported persistence envelope');
  const decipher = createDecipheriv('aes-256-gcm', assertKey(key), Buffer.from(value.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

