import { randomBytes } from 'node:crypto';
import path from 'node:path';

function required(name, { allowTestDefault = false } = {}) {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (allowTestDefault && process.env.NODE_ENV === 'test') return randomBytes(32).toString('base64url');
  throw new Error(`Missing required environment variable: ${name}`);
}

function parseActivationCodes(raw) {
  const entries = new Map();
  for (const item of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    const split = item.indexOf(':');
    const code = split >= 0 ? item.slice(0, split).trim() : item;
    const studentId = split >= 0 ? item.slice(split + 1).trim() : `student-${entries.size + 1}`;
    if (!code || !studentId) throw new Error('STUDENT_ACTIVATION_CODES contains an invalid entry');
    entries.set(code, studentId);
  }
  if (entries.size === 0) throw new Error('STUDENT_ACTIVATION_CODES must contain at least one code');
  return entries;
}

function decodeEncryptionKey(raw) {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === '0') return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

export function loadConfig(overrides = {}) {
  const test = process.env.NODE_ENV === 'test';
  const encryptionRaw = overrides.masterEncryptionKeyRaw ?? required('MASTER_ENCRYPTION_KEY', { allowTestDefault: true });
  return {
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    port: Number(overrides.port ?? process.env.PORT ?? 8787),
    publicBaseUrl: overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${overrides.port ?? process.env.PORT ?? 8787}`,
    dataDir: path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? './data'),
    masterEncryptionKey: overrides.masterEncryptionKey ?? decodeEncryptionKey(encryptionRaw),
    adminApiKey: overrides.adminApiKey ?? required('ADMIN_API_KEY', { allowTestDefault: true }),
    studentTokenSecret: overrides.studentTokenSecret ?? required('STUDENT_TOKEN_SECRET', { allowTestDefault: true }),
    studentTokenTtlMs: Number(overrides.studentTokenTtlMs ?? process.env.STUDENT_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
    activationCodes: overrides.activationCodes ?? parseActivationCodes(process.env.STUDENT_ACTIVATION_CODES ?? (test ? 'test-code:test-student' : '')),
    trustProxy: parseBoolean(overrides.trustProxy ?? process.env.TRUST_PROXY, false),
    sessionTtlMs: Number(overrides.sessionTtlMs ?? process.env.SESSION_TTL_MS ?? 6 * 60 * 60 * 1000),
    maxSupplementChars: Number(overrides.maxSupplementChars ?? process.env.MAX_SUPPLEMENT_CHARS ?? 200_000),
    sttProvider: overrides.sttProvider ?? process.env.STT_PROVIDER ?? 'seed-asr',
    seedAsr: {
      apiKey: overrides.seedAsrApiKey ?? process.env.SEED_ASR_API_KEY ?? '',
      resourceId: overrides.seedAsrResourceId ?? process.env.SEED_ASR_RESOURCE_ID ?? 'volc.seedasr.sauc.duration',
      endpoint: overrides.seedAsrEndpoint ?? process.env.SEED_ASR_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
    },
    llm: {
      provider: overrides.llmProvider ?? process.env.LLM_PROVIDER ?? 'codex-config',
      codexConfigPath: overrides.codexConfigPath ?? process.env.CODEX_CONFIG_PATH ?? '',
      codexAuthPath: overrides.codexAuthPath ?? process.env.CODEX_AUTH_PATH ?? '',
      baseUrl: (overrides.llmBaseUrl ?? process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey: overrides.llmApiKey ?? process.env.LLM_API_KEY ?? '',
      model: overrides.llmModel ?? process.env.LLM_MODEL ?? 'gpt-5.6-sol',
      reasoningEffort: overrides.llmReasoningEffort ?? process.env.LLM_REASONING_EFFORT ?? 'low',
      contextWindowTokens: Number(overrides.llmContextWindowTokens ?? process.env.LLM_CONTEXT_WINDOW_TOKENS ?? 1_000_000),
    },
  };
}
