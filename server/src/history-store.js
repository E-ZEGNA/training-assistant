import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createPersistenceQueue } from './persistence.js';

const ids = {
  session: (sessionId) => `session:${sessionId}`,
  transcript: (sessionId, channel, utteranceId) => `transcript:${sessionId}:${channel}:${utteranceId}`,
  answer: (sessionId, answerId) => `answer:${sessionId}:${answerId}`,
  memory: (studentId) => `memory:${studentId}`,
  provider: (studentId) => `provider:${studentId}`,
};

function publicProvider(provider) {
  return provider?.configured === true ? {
    configured: true,
    baseUrl: provider.baseUrl,
    llmModel: provider.llmModel,
    sttModel: provider.sttModel,
    llmAvailable: provider.llmAvailable === true,
    sttAvailable: provider.sttAvailable === true,
  } : { configured: false };
}

export class HistoryStore extends EventEmitter {
  constructor(queue) {
    super();
    this.queue = queue;
    queue.on('degraded', (event) => this.emit('degraded', event));
  }

  observe(promise, operation) {
    promise.catch((error) => this.emit('write-error', { operation, error: error.message }));
    return promise;
  }

  recordSession(session, status = 'active', endedAt = null) {
    const value = {
      id: session.id,
      studentId: session.studentId,
      supplement: session.supplement,
      createdAt: session.createdAt,
      endedAt,
      status,
    };
    return this.observe(this.queue.put({
      id: ids.session(session.id),
      studentId: session.studentId,
      kind: 'session',
      value,
      updatedAt: endedAt ?? session.createdAt,
    }), 'record_session');
  }

  recordTranscript(session, item) {
    return this.observe(this.queue.put({
      id: ids.transcript(session.id, item.channel, item.utteranceId),
      studentId: session.studentId,
      kind: 'transcript',
      value: { sessionId: session.id, ...item },
      updatedAt: item.at,
    }), 'record_transcript');
  }

  recordAnswer(session, item) {
    const answerId = item.id ?? `${item.at}-${randomUUID()}`;
    return this.observe(this.queue.put({
      id: ids.answer(session.id, answerId),
      studentId: session.studentId,
      kind: 'answer',
      value: { sessionId: session.id, id: answerId, ...item },
      updatedAt: item.at,
    }), 'record_answer');
  }

  async getProvider(studentId) {
    const record = await this.queue.get({ id: ids.provider(studentId), studentId });
    return record?.value?.configured === true ? record.value : null;
  }

  async providerStatus(studentId) {
    return publicProvider(await this.getProvider(studentId));
  }

  async setProvider(studentId, provider) {
    const value = { configured: true, ...provider, updatedAt: Date.now() };
    await this.queue.put({ id: ids.provider(studentId), studentId, kind: 'provider', value, updatedAt: value.updatedAt });
    return publicProvider(value);
  }

  async clearProvider(studentId) {
    const value = { configured: false, updatedAt: Date.now() };
    await this.queue.put({ id: ids.provider(studentId), studentId, kind: 'provider', value, updatedAt: value.updatedAt });
    return { configured: false };
  }

  async getMemory(studentId) {
    const record = await this.queue.get({ id: ids.memory(studentId), studentId });
    return record?.value ?? null;
  }

  async setMemory(studentId, memory) {
    await this.queue.put({
      id: ids.memory(studentId),
      studentId,
      kind: 'memory',
      value: memory,
      updatedAt: memory.updatedAt,
    });
    return memory;
  }

  async listStudents() {
    const rows = await this.queue.students();
    const students = [];
    for (const row of rows) {
      const records = await this.queue.list({ studentId: row.studentId });
      const sessions = records.filter((record) => record.kind === 'session').map((record) => record.value);
      const memory = records.find((record) => record.kind === 'memory')?.value ?? null;
      students.push({
        studentId: row.studentId,
        sessionCount: sessions.length,
        lastInterviewAt: sessions.reduce((latest, session) => Math.max(latest, session.createdAt ?? 0), 0) || null,
        memoryUpdatedAt: memory?.updatedAt ?? null,
      });
    }
    return students.sort((left, right) => (right.lastInterviewAt ?? 0) - (left.lastInterviewAt ?? 0));
  }

  async listSessions(studentId) {
    const records = await this.queue.list({ studentId });
    return records
      .filter((record) => record.kind === 'session')
      .map((record) => record.value)
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  }

  async getStudentDetail(studentId) {
    const records = await this.queue.list({ studentId });
    if (!records.length) return null;
    return {
      studentId,
      memory: records.find((record) => record.kind === 'memory')?.value ?? null,
      provider: publicProvider(records.find((record) => record.kind === 'provider')?.value),
      sessions: records.filter((record) => record.kind === 'session').map((record) => record.value)
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)),
    };
  }

  async getSessionDetail(studentId, sessionId) {
    const records = await this.queue.list({ studentId });
    const session = records.find((record) => record.id === ids.session(sessionId))?.value;
    if (!session) return null;
    return {
      ...session,
      transcripts: records.filter((record) => record.kind === 'transcript' && record.value.sessionId === sessionId)
        .map((record) => record.value).sort((left, right) => (left.revision ?? 0) - (right.revision ?? 0)),
      answers: records.filter((record) => record.kind === 'answer' && record.value.sessionId === sessionId)
        .map((record) => record.value).sort((left, right) => (left.at ?? 0) - (right.at ?? 0)),
    };
  }

  async deleteSession(studentId, sessionId, deletedAt = Date.now()) {
    const records = await this.queue.list({ studentId });
    const matching = records.filter((record) => record.id === ids.session(sessionId)
      || ((record.kind === 'transcript' || record.kind === 'answer') && record.value.sessionId === sessionId));
    await Promise.all(matching.map((record) => this.queue.deleteRecord(record.id, deletedAt)));
    return { deleted: matching.length > 0 };
  }

  async deleteStudent(studentId, deletedAt = Date.now()) {
    return this.queue.deleteStudent(studentId, deletedAt);
  }

  close() {
    return this.queue.close();
  }
}

export async function createHistoryStore(config) {
  const queue = await createPersistenceQueue({
    dataDir: config.dataDir,
    encryptionKey: config.masterEncryptionKey,
    queueLimit: config.persistenceQueueLimit,
  });
  return new HistoryStore(queue);
}
