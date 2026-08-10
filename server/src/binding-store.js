import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function sameFingerprint(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function validRecord(record) {
  return record
    && typeof record.studentId === 'string'
    && typeof record.bindingId === 'string'
    && typeof record.deviceHash === 'string'
    && typeof record.ipHash === 'string'
    && ['active', 'revoked'].includes(record.status)
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string';
}

export class StudentBindingStore {
  constructor(dataDir, secret) {
    this.filePath = path.join(dataDir, 'student-bindings.json');
    this.secret = secret;
    this.bindings = new Map();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  fingerprint(kind, value) {
    return createHmac('sha256', this.secret).update(`${kind}\0${value}`).digest('base64url');
  }

  load() {
    let raw;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const document = JSON.parse(raw);
    if (document?.version !== 1 || !Array.isArray(document.bindings) || !document.bindings.every(validRecord)) {
      throw new Error('Student binding store is invalid');
    }
    for (const record of document.bindings) {
      if (this.bindings.has(record.studentId)) throw new Error('Student binding store contains duplicate students');
      this.bindings.set(record.studentId, record);
    }
  }

  persist() {
    const temporary = `${this.filePath}.tmp`;
    const document = { version: 1, bindings: [...this.bindings.values()] };
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  activate(studentId, deviceId, clientIp) {
    const deviceHash = this.fingerprint('device', deviceId);
    const ipHash = this.fingerprint('ip', clientIp);
    const existing = this.bindings.get(studentId);
    if (existing) {
      if (existing.status === 'revoked') return { ok: false, reason: 'revoked' };
      if (!sameFingerprint(existing.deviceHash, deviceHash) || !sameFingerprint(existing.ipHash, ipHash)) {
        return { ok: false, reason: 'already_bound' };
      }
      existing.updatedAt = new Date().toISOString();
      this.persist();
      return { ok: true, binding: existing };
    }

    const now = new Date().toISOString();
    const binding = {
      studentId,
      bindingId: randomUUID(),
      deviceHash,
      ipHash,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.bindings.set(studentId, binding);
    this.persist();
    return { ok: true, binding };
  }

  verify({ studentId, bindingId, deviceId, clientIp }) {
    const binding = this.bindings.get(studentId);
    if (!binding || binding.status !== 'active' || binding.bindingId !== bindingId) return false;
    return sameFingerprint(binding.deviceHash, this.fingerprint('device', deviceId))
      && sameFingerprint(binding.ipHash, this.fingerprint('ip', clientIp));
  }

  revoke(studentId) {
    const binding = this.bindings.get(studentId);
    if (!binding) return false;
    if (binding.status !== 'revoked') {
      binding.status = 'revoked';
      binding.updatedAt = new Date().toISOString();
      this.persist();
    }
    return true;
  }

  reset(studentId) {
    if (!this.bindings.delete(studentId)) return false;
    this.persist();
    return true;
  }

  list() {
    return [...this.bindings.values()]
      .map(({ deviceHash: _deviceHash, ipHash: _ipHash, ...record }) => ({ ...record }))
      .sort((left, right) => left.studentId.localeCompare(right.studentId));
  }
}
