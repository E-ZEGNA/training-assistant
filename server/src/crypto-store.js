import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FORMAT_VERSION = 1;

export class MasterPackStore {
  constructor(dataDir, encryptionKey) {
    this.dataDir = dataDir;
    this.encryptionKey = encryptionKey;
    this.filePath = path.join(dataDir, 'master-pack.enc.json');
  }

  async put({ text, version }) {
    if (typeof text !== 'string' || text.trim().length < 10) throw new Error('Master pack is too short');
    if (text.length > 2_000_000) throw new Error('Master pack exceeds 2,000,000 characters');
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
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    return { version, updatedAt: JSON.parse(payload.toString('utf8')).updatedAt, characters: text.length };
  }

  async get() {
    const envelope = JSON.parse(await readFile(this.filePath, 'utf8'));
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

  async status() {
    try {
      const pack = await this.get();
      return { configured: true, version: pack.version, updatedAt: pack.updatedAt, characters: pack.text.length };
    } catch (error) {
      if (error?.code === 'ENOENT') return { configured: false };
      throw error;
    }
  }
}
