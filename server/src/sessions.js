import { randomUUID } from 'node:crypto';
import { buildHotwords } from './retrieval.js';
import { MockAsrStream, SeedAsrStream } from './seed-asr.js';

export class SessionStore {
  constructor(config, masterStore) {
    this.config = config;
    this.masterStore = masterStore;
    this.sessions = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref?.();
  }

  async create(studentId, supplement) {
    if (typeof supplement !== 'string') {
      const error = new Error('Supplement must be text');
      error.statusCode = 400;
      throw error;
    }
    if (supplement.length > this.config.maxSupplementChars) {
      const error = new Error('Supplement is too large');
      error.statusCode = 400;
      throw error;
    }
    const master = await this.masterStore.get();
    const now = Date.now();
    const session = {
      id: randomUUID(),
      studentId,
      supplement,
      createdAt: now,
      expiresAt: now + this.config.sessionTtlMs,
      transcripts: [],
      partialByChannel: new Map(),
      audioStreams: new Map(),
      answerHistory: [],
      hotwords: buildHotwords(master.text, supplement),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id, studentId) {
    const session = this.sessions.get(id);
    if (!session || session.studentId !== studentId || session.expiresAt <= Date.now()) return null;
    session.expiresAt = Date.now() + this.config.sessionTtlMs;
    return session;
  }

  createAsr(session, channel) {
    const existing = session.audioStreams.get(channel);
    existing?.stop();
    const common = { uid: `${session.studentId}-${channel}`, hotwords: session.hotwords };
    const stream = this.config.sttProvider === 'mock'
      ? new MockAsrStream()
      : new SeedAsrStream({ ...this.config.seedAsr, ...common });
    session.audioStreams.set(channel, stream);
    return stream;
  }

  addTranscript(session, channel, event) {
    const text = String(event.text ?? '').trim();
    if (!text) return;
    session.partialByChannel.set(channel, text);
    if (event.final) {
      const previous = session.transcripts.at(-1);
      if (!previous || previous.text !== text || previous.channel !== channel) {
        session.transcripts.push({ channel, text, at: Date.now() });
        if (session.transcripts.length > 500) session.transcripts.splice(0, session.transcripts.length - 500);
      }
      session.partialByChannel.delete(channel);
    }
  }

  context(session, seconds = 150) {
    const since = Date.now() - seconds * 1000;
    const finalized = session.transcripts
      .filter((item) => item.at >= since)
      .map((item) => `${item.channel === 'system' ? '面试官' : '学员'}：${item.text}`);
    for (const [channel, text] of session.partialByChannel) {
      finalized.push(`${channel === 'system' ? '面试官' : '学员'}（正在说）：${text}`);
    }
    return finalized.join('\n').slice(-14_000);
  }

  end(id, studentId) {
    const session = this.get(id, studentId);
    if (!session) return false;
    for (const stream of session.audioStreams.values()) stream.stop();
    session.supplement = '';
    session.hotwords = [];
    session.transcripts = [];
    session.partialByChannel.clear();
    session.answerHistory = [];
    this.sessions.delete(id);
    return true;
  }

  cleanup() {
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= Date.now()) this.end(session.id, session.studentId);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const session of [...this.sessions.values()]) this.end(session.id, session.studentId);
  }
}
