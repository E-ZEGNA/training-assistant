import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

mkdirSync(path.dirname(workerData.dbPath), { recursive: true });
const db = new DatabaseSync(workerData.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS persistence_records (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'record',
    payload TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS persistence_records_student_idx
    ON persistence_records(student_id, deleted, updated_at DESC);
  CREATE TABLE IF NOT EXISTS persistence_tombstones (
    student_id TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS persistence_record_tombstones (
    id TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  );
`);

try { db.exec("ALTER TABLE persistence_records ADD COLUMN kind TEXT NOT NULL DEFAULT 'record'"); } catch {}

let failNext = false;

function run(operation) {
  if (operation.type === 'put') {
    if (failNext) {
      failNext = false;
      throw new Error('Injected persistence failure');
    }
    const tombstone = db.prepare('SELECT student_id, deleted_at AS deletedAt FROM persistence_tombstones WHERE student_id = ?').get(operation.studentId);
    const recordTombstone = db.prepare('SELECT id, deleted_at AS deletedAt FROM persistence_record_tombstones WHERE id = ?').get(operation.id);
    if (tombstone && operation.updatedAt <= tombstone.deletedAt) return { ignored: true, reason: 'student_deleted' };
    if (recordTombstone && operation.updatedAt <= recordTombstone.deletedAt) return { ignored: true, reason: 'record_deleted' };
    if (tombstone) db.prepare('DELETE FROM persistence_tombstones WHERE student_id = ?').run(operation.studentId);
    if (recordTombstone) db.prepare('DELETE FROM persistence_record_tombstones WHERE id = ?').run(operation.id);
    db.prepare(`
      INSERT INTO persistence_records (id, student_id, kind, payload, deleted, updated_at)
      VALUES (?, ?, ?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET
        student_id = excluded.student_id,
        kind = excluded.kind,
        payload = excluded.payload,
        deleted = 0,
        updated_at = excluded.updated_at
    `).run(operation.id, operation.studentId, operation.kind ?? 'record', operation.payload, operation.updatedAt);
    return { saved: true };
  }
  if (operation.type === 'get') {
    return db.prepare(`
      SELECT id, student_id AS studentId, kind, payload, updated_at AS updatedAt
      FROM persistence_records
      WHERE id = ? AND student_id = ? AND deleted = 0
    `).get(operation.id, operation.studentId) ?? null;
  }
  if (operation.type === 'list') {
    return db.prepare(`
      SELECT id, student_id AS studentId, kind, payload, updated_at AS updatedAt
      FROM persistence_records
      WHERE student_id = ? AND deleted = 0
      ORDER BY updated_at DESC
    `).all(operation.studentId);
  }
  if (operation.type === 'students') {
    return db.prepare(`
      SELECT student_id AS studentId, MAX(updated_at) AS lastUpdated, COUNT(*) AS recordCount
      FROM persistence_records
      WHERE deleted = 0
      GROUP BY student_id
      ORDER BY lastUpdated DESC
    `).all();
  }
  if (operation.type === 'deleteRecord') {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        INSERT INTO persistence_record_tombstones (id, deleted_at) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at
      `).run(operation.id, operation.deletedAt);
      db.prepare('UPDATE persistence_records SET deleted = 1, updated_at = ? WHERE id = ?').run(operation.deletedAt, operation.id);
      db.exec('COMMIT');
      return { deleted: true };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  if (operation.type === 'deleteStudent') {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        INSERT INTO persistence_tombstones (student_id, deleted_at) VALUES (?, ?)
        ON CONFLICT(student_id) DO UPDATE SET deleted_at = excluded.deleted_at
      `).run(operation.studentId, operation.deletedAt);
      db.prepare('UPDATE persistence_records SET deleted = 1, updated_at = ? WHERE student_id = ?').run(operation.deletedAt, operation.studentId);
      db.exec('COMMIT');
      return { deleted: true };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  if (operation.type === 'failNext') {
    failNext = true;
    return { armed: true };
  }
  throw new Error(`Unknown persistence operation: ${operation.type}`);
}

parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (message) => {
  if (message.type === 'shutdown') {
    db.close();
    parentPort.postMessage({ type: 'closed' });
    return;
  }
  try {
    parentPort.postMessage({ type: 'result', id: message.requestId, result: run(message) });
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: message.requestId, error: error?.message ?? 'Persistence operation failed' });
  }
});
