import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { decryptJson, encryptJson } from './persistence-crypto.js';

const workerUrl = new URL('./persistence-worker.js', import.meta.url);

export class PersistenceQueue extends EventEmitter {
  constructor({ dataDir, encryptionKey, queueLimit = 1000, workerPath = workerUrl } = {}) {
    super();
    this.dataDir = path.resolve(dataDir ?? './data');
    this.encryptionKey = Buffer.from(encryptionKey ?? '');
    if (this.encryptionKey.length !== 32) throw new Error('Persistence encryption key must be 32 bytes');
    this.queueLimit = queueLimit;
    this.queue = [];
    this.pending = new Map();
    this.inFlight = false;
    this.closed = false;
    this.closing = false;
    this.degraded = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(workerPath, {
      workerData: { dbPath: path.join(this.dataDir, 'interview-history.sqlite') },
      // Do not inherit test/debug flags that Node workers reject (or --input-type from evals).
      execArgv: [],
    });
    this.worker.on('message', (message) => this.handleMessage(message));
    this.worker.on('error', (error) => this.failWorker(error));
    this.worker.on('exit', (code) => {
      if (!this.closed && code !== 0) this.failWorker(new Error(`Persistence worker exited (${code})`));
    });
  }

  handleMessage(message) {
    if (message.type === 'ready') {
      this.resolveReady();
      this.flush();
      return;
    }
    if (message.type === 'closed') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.inFlight = false;
    if (message.type === 'error') {
      this.degraded = true;
      this.emit('degraded', { error: message.error });
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
    this.flush();
  }

  failWorker(error) {
    if (this.degraded && this.readySettled) return;
    this.degraded = true;
    this.readySettled = true;
    this.rejectReady?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const item of this.queue.splice(0)) item.reject(error);
    this.inFlight = false;
    this.emit('degraded', { error: error.message });
  }

  enqueue(operation) {
    if (this.closed || this.closing) return Promise.reject(new Error('Persistence queue is closed'));
    if (this.degraded) return Promise.reject(new Error('Persistence queue is degraded'));
    if (this.queue.length + this.pending.size >= this.queueLimit) {
      const error = new Error('Persistence queue is full');
      error.code = 'persistence_queue_full';
      this.emit('degraded', { error: error.message });
      return Promise.reject(error);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.queue.push({ id, operation, resolve, reject });
      this.flush();
    });
  }

  flush() {
    if (this.inFlight || this.closed || this.degraded || !this.queue.length) return;
    this.inFlight = true;
    const item = this.queue.shift();
    this.pending.set(item.id, item);
    this.worker.postMessage({ requestId: item.id, ...item.operation });
  }

  async put({ id, studentId, kind = 'record', value, updatedAt = Date.now() }) {
    return this.enqueue({ type: 'put', id, studentId, kind, payload: encryptJson(value, this.encryptionKey), updatedAt });
  }

  async get({ id, studentId }) {
    await this.ready;
    const row = await this.enqueue({ type: 'get', id, studentId });
    return row ? { ...row, value: decryptJson(row.payload, this.encryptionKey) } : null;
  }

  async list({ studentId }) {
    await this.ready;
    const rows = await this.enqueue({ type: 'list', studentId });
    return rows.map((row) => ({ ...row, value: decryptJson(row.payload, this.encryptionKey) }));
  }

  async students() {
    await this.ready;
    return this.enqueue({ type: 'students' });
  }

  async deleteRecord(id, deletedAt = Date.now()) {
    await this.ready;
    return this.enqueue({ type: 'deleteRecord', id, deletedAt });
  }

  async deleteStudent(studentId, deletedAt = Date.now()) {
    await this.ready;
    return this.enqueue({ type: 'deleteStudent', studentId, deletedAt });
  }

  async failNextForTesting() {
    await this.ready;
    return this.enqueue({ type: 'failNext' });
  }

  async terminateForTesting() {
    this.worker.terminate();
    await new Promise((resolve) => setImmediate(resolve));
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    const deadline = Date.now() + 5_000;
    while (!this.degraded && (this.queue.length || this.pending.size || this.inFlight) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('Persistence queue is closing'));
    this.pending.clear();
    for (const item of this.queue.splice(0)) item.reject(new Error('Persistence queue is closing'));
    await this.worker.terminate();
  }
}

export async function createPersistenceQueue(options) {
  await mkdir(options.dataDir, { recursive: true });
  const queue = new PersistenceQueue(options);
  await queue.ready;
  return queue;
}
