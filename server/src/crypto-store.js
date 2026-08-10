import { createCipheriv, createHash, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FORMAT_VERSION = 1;
const LEGACY_STUDENT_ID = 'default';
const STUDENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function normalizeStudentId(studentId, { allowLegacyDefault = false } = {}) {
  if (studentId === undefined && allowLegacyDefault) return undefined;
  const value = String(studentId ?? '').trim();
  if (!STUDENT_ID_PATTERN.test(value)) {
    const error = new Error('Invalid student id');
    error.statusCode = 400;
    error.publicCode = 'invalid_student_id';
    throw error;
  }
  return value;
}

export class MasterPackStore {
  constructor(dataDir, encryptionKey) {
    this.dataDir = dataDir;
    this.encryptionKey = encryptionKey;
    this.legacyFilePath = path.join(dataDir, 'master-pack.enc.json');
  }

  filePath(studentId) {
    const normalized = normalizeStudentId(studentId, { allowLegacyDefault: true });
    if (normalized === undefined || normalized === LEGACY_STUDENT_ID) {
      return this.legacyFilePath;
    }
    const digest = createHash('sha256').update(normalized).digest('hex');
    return path.join(this.dataDir, `master-pack-${digest}.enc.json`);
  }

  async put({ studentId, text, version }) {
    if (typeof text !== 'string' || text.trim().length < 10) throw new Error('Master pack is too short');
    if (text.length > 2_000_000) throw new Error('Master pack exceeds 2,000,000 characters');
    const filePath = this.filePath(studentId);
    const payload = Buffer.from(JSON.stringify({ text, version, updatedAt: new Date().toISOString() }), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const envelope = {
      format: FORMAT_VERSION,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
    return { version, updatedAt: JSON.parse(payload.toString('utf8')).updatedAt, characters: text.length };
  }

  async get(studentId) {
    const envelope = JSON.parse(await readFile(this.filePath(studentId), 'utf8'));
    if (envelope.format !== FORMAT_VERSION || envelope.algorithm !== 'aes-256-gcm') {
      throw new Error('Unsupported master pack format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  async status(studentId) {
    try {
      const pack = await this.get(studentId);
      return { configured: true, version: pack.version, updatedAt: pack.updatedAt, characters: pack.text.length };
    } catch (error) {
      if (error?.code === 'ENOENT') return { configured: false };
      throw error;
    }
  }

  async hasAny() {
    let entries;
    try {
      entries = await readdir(this.dataDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    return entries.some((name) => name === path.basename(this.legacyFilePath) || /^master-pack-[a-f0-9]{64}\.enc\.json$/.test(name));
  }
}

export { LEGACY_STUDENT_ID };
