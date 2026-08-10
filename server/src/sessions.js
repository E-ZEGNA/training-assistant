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
      partialByUtterance: new Map(),
      audioStreams: new Map(),
      answerHistory: [],
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
    const compacted = [];
    for (const entry of entries) {
      const previous = compacted.at(-1);
      if (previous?.channel === entry.channel) {
        if (previous.text === entry.text) {
          if (entry.final) compacted[compacted.length - 1] = entry;
          continue;
        }
        if (previous.text.startsWith(entry.text)) continue;
        if (entry.text.startsWith(previous.text)) {
          compacted[compacted.length - 1] = entry;
          continue;
        }
      }
      compacted.push(entry);
    }
    const text = compacted.map(({ channel, text: value, final }) => {
      const speaker = channel === 'system' ? '面试官' : '学员';
      return `${speaker}${final ? '' : '（正在说）'}：${value}`;
    }).join('\n');
    return { text, revision: session.transcriptRevision };
  }

  markAnswered(session, revision) {
    if (Number.isSafeInteger(revision)) session.answeredRevision = Math.max(session.answeredRevision, revision);
  }

  end(id, studentId) {
    const session = this.get(id, studentId);
    if (!session) return false;
    for (const stream of session.audioStreams.values()) stream.stop();
    session.supplement = '';
    session.hotwords = [];
    session.transcripts = [];
    session.partialByUtterance.clear();
    session.answerHistory = [];
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
