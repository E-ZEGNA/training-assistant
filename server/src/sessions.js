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
    let master;
    try {
      master = await this.masterStore.get(studentId);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const missing = new Error('Master pack is not configured for this student');
        missing.statusCode = 503;
        missing.publicCode = 'master_pack_not_configured';
        throw missing;
      }
      throw error;
    }
    for (const existing of [...this.sessions.values()]) {
      if (existing.studentId === studentId) this.end(existing.id, studentId);
    }
    const now = Date.now();
    const session = {
      id: randomUUID(),
      studentId,
      supplement,
      createdAt: now,
      expiresAt: now + this.config.sessionTtlMs,
      transcripts: [],
      partialByUtterance: new Map(),
      audioStreams: new Map(),
      clientSockets: new Map(),
      answerHistory: [],
      answerInProgress: false,
      pendingAnswerContext: null,
      transcriptRevision: 0,
      answeredRevision: 0,
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
    const revision = ++session.transcriptRevision;
    const utteranceId = String(event.utteranceId ?? 'current');
    const partialKey = `${channel}:${utteranceId}`;
    session.partialByUtterance.set(partialKey, { channel, text, utteranceId, revision });
    if (event.final) {
      const previous = session.transcripts.find((item) => item.utteranceId === utteranceId && item.channel === channel);
      if (!previous) {
        session.transcripts.push({ channel, text, utteranceId, at: Date.now(), revision });
      } else {
        previous.text = text;
        previous.at = Date.now();
        previous.revision = revision;
      }
      session.partialByUtterance.delete(partialKey);
    }
  }

  context(session) {
    const entries = session.transcripts
      .filter((item) => item.revision > session.answeredRevision)
      .map((item) => ({ ...item, final: true }));
    for (const item of session.partialByUtterance.values()) {
      if (item.revision > session.answeredRevision) entries.push({ ...item, final: false });
    }
    entries.sort((left, right) => left.revision - right.revision);
    const text = entries.map(({ channel, text: value, final }) => {
      const speaker = channel === 'system' ? '面试官' : '学员';
      return `${speaker}${final ? '' : '（正在说）'}：${value}`;
    }).join('\n');
    return { text, revision: session.transcriptRevision };
  }

  answerContext(session) {
    if (session.pendingAnswerContext) return session.pendingAnswerContext;
    const context = this.context(session);
    if (context.text.trim()) session.pendingAnswerContext = context;
    return context;
  }

  markAnswered(session, revision) {
    if (Number.isSafeInteger(revision)) {
      session.answeredRevision = Math.max(session.answeredRevision, revision);
      if (session.pendingAnswerContext?.revision <= session.answeredRevision) session.pendingAnswerContext = null;
    }
  }

  end(id, studentId) {
    const session = this.sessions.get(id);
    if (!session || session.studentId !== studentId) return false;
    for (const stream of session.audioStreams.values()) stream.stop();
    for (const socket of session.clientSockets.values()) socket.close(1000, 'session ended');
    session.supplement = '';
    session.hotwords = [];
    session.transcripts = [];
    session.partialByUtterance.clear();
    session.answerHistory = [];
    session.answerInProgress = false;
    session.pendingAnswerContext = null;
    session.transcriptRevision = 0;
    session.answeredRevision = 0;
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
