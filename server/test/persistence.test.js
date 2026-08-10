import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createPersistenceQueue } from '../src/persistence.js';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'interview-persistence-'));
}

test('encrypted persistence survives worker restart without plaintext on disk', async () => {
  const dataDir = await tempDir();
  const key = randomBytes(32);
  const first = await createPersistenceQueue({ dataDir, encryptionKey: key });
  await first.put({ id: 'session-1', studentId: 'student-1', value: { supplement: '敏感补充', answer: '完整回答' } });
  await first.close();

  const disk = await readFile(path.join(dataDir, 'interview-history.sqlite'));
  assert.equal(disk.includes('敏感补充'), false);
  assert.equal(disk.includes('完整回答'), false);

  const second = await createPersistenceQueue({ dataDir, encryptionKey: key });
  const restored = await second.get({ id: 'session-1', studentId: 'student-1' });
  assert.equal(restored.id, 'session-1');
  assert.equal(restored.studentId, 'student-1');
  assert.equal(typeof restored.payload, 'string');
  assert.equal(Number.isFinite(restored.updatedAt), true);
  assert.deepEqual(restored.value, { supplement: '敏感补充', answer: '完整回答' });
  await second.close();
});

test('student tombstone prevents late queued writes from resurrecting deleted history', async () => {
  const dataDir = await tempDir();
  const queue = await createPersistenceQueue({ dataDir, encryptionKey: randomBytes(32) });
  await queue.put({ id: 'session-1', studentId: 'student-1', value: { transcript: 'old' } });
  const deletedAt = Date.now();
  await queue.deleteStudent('student-1', deletedAt);
  const late = await queue.put({ id: 'session-2', studentId: 'student-1', value: { transcript: 'late' }, updatedAt: deletedAt - 1 });
  assert.deepEqual(late, { ignored: true, reason: 'student_deleted' });
  assert.deepEqual(await queue.list({ studentId: 'student-1' }), []);
  await queue.close();
});

test('queue operations are non-blocking at the call site and surface worker failure asynchronously', async () => {
  const dataDir = await tempDir();
  const queue = await createPersistenceQueue({ dataDir, encryptionKey: randomBytes(32), queueLimit: 2 });
  const started = performance.now();
  const write = queue.put({ id: 'session-1', studentId: 'student-1', value: { transcript: 'queued' } });
  assert.ok(performance.now() - started < 50);
  await write;

  await queue.failNextForTesting();
  await assert.rejects(queue.put({ id: 'session-2', studentId: 'student-1', value: { transcript: 'failure' } }), /Injected persistence failure/);
  await queue.terminateForTesting();
  await assert.rejects(queue.put({ id: 'session-3', studentId: 'student-1', value: { transcript: 'worker down' } }), /degraded|worker|closed/i);
  await queue.close();
});

test('queue full is observable without waiting for the database', async () => {
  const dataDir = await tempDir();
  const queue = await createPersistenceQueue({ dataDir, encryptionKey: randomBytes(32), queueLimit: 1 });
  await queue.terminateForTesting();
  await assert.rejects(queue.put({ id: 'session-1', studentId: 'student-1', value: { transcript: 'one' } }), /degraded|worker|closed/i);
  await queue.close();
});
