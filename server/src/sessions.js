import { randomUUID } from 'node:crypto';
import { buildHotwords } from './retrieval.js';
import { MockAsrStream } from './seed-asr.js';
import { createStudentAsrStream } from './xiaomuai.js';
import { generateStudentMemory } from './llm.js';

export class SessionStore {
  constructor(config, masterStore, historyStore = null) {
    this.config = config;
    this.masterStore = masterStore;
    this.historyStore = historyStore;
    this.sessions = new Map();
    this.memoryJobs = new Map();
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
    const storedProvider = this.historyStore ? await this.historyStore.getProvider(studentId) : null;
    const provider = storedProvider ? {
      ...storedProvider,
      sttModel: this.config.xiaomuai.sttModel,
      sttAvailable: false,
    } : null;
    if (this.config.requireStudentProvider && !provider) {
      const error = new Error('Student provider is not configured');
      error.statusCode = 412;
      error.code = 'provider_not_configured';
      throw error;
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
      answerHistory: [],
      transcriptRevision: 0,
      answeredRevision: 0,
      hotwords: buildHotwords(master.text, supplement),
      provider,
      memory: this.historyStore ? await this.historyStore.getMemory(studentId) : null,
    };
    this.sessions.set(session.id, session);
    this.historyStore?.recordSession(session);
    return session;
  }

  get(id, studentId) {
    const session = this.sessions.get(id);
    if (!session || session.studentId !== studentId || session.expiresAt <= Date.now()) return null;
    session.expiresAt = Date.now() + this.config.sessionTtlMs;
    return session;
  }

  list(studentId) {
    return [...this.sessions.values()].filter((session) => session.studentId === studentId);
  }

  createAsr(session, channel) {
    const existing = session.audioStreams.get(channel);
    existing?.stop();
    const common = { uid: `${session.studentId}-${channel}`, hotwords: session.hotwords };
    const stream = this.config.sttProvider === 'mock'
      ? new MockAsrStream()
      : createStudentAsrStream({
        provider: session.provider ? { ...session.provider, timeoutMs: this.config.xiaomuai.timeoutMs } : null,
        seedConfig: this.config.seedAsr,
        ...common,
      });
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
      const saved = session.transcripts.find((item) => item.utteranceId === utteranceId && item.channel === channel);
      if (saved) this.historyStore?.recordTranscript(session, saved);
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

  end(id, studentId, status = 'ended') {
    // Ending is also used by TTL cleanup and admin shutdown, where the live
    // session may already be past its access expiry. Do not route through get().
    const session = this.sessions.get(id);
    if (!session || session.studentId !== studentId) return false;
    for (const stream of session.audioStreams.values()) stream.stop();
    this.historyStore?.recordSession(session, status, Date.now());
    this.scheduleMemory(session);
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
      if (session.expiresAt <= Date.now()) this.end(session.id, session.studentId, 'expired');
    }
  }

  scheduleMemory(session) {
    if (!this.historyStore) return;
    const snapshot = {
      ...session,
      supplement: session.supplement,
      answerHistory: [...session.answerHistory],
      transcripts: session.transcripts.map((item) => ({ ...item })),
      provider: session.provider ? { ...session.provider } : null,
    };
    const previous = this.memoryJobs.get(session.studentId) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const memory = await generateStudentMemory({ config: this.config, session: snapshot });
      const previousMemory = await this.historyStore.getMemory(session.studentId);
      // A failed/unavailable memory model must never replace a known-good version.
      // If this is the first interview, keep the bounded local fallback so the
      // administrator still has something to review.
      if (memory?.generated === false && previousMemory) return;
      const { generated: _generated, ...persistedMemory } = memory ?? {};
      if (memory) await this.historyStore.setMemory(session.studentId, persistedMemory);
    }).catch((error) => this.historyStore.emit('memory-error', { studentId: session.studentId, error: error.message }));
    const tracked = job.finally(() => {
      if (this.memoryJobs.get(session.studentId) === tracked) this.memoryJobs.delete(session.studentId);
    });
    this.memoryJobs.set(session.studentId, tracked);
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const session of [...this.sessions.values()]) this.end(session.id, session.studentId);
  }

  async waitForMemoryJobs() {
    await Promise.allSettled([...this.memoryJobs.values()]);
  }
}
