import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve('.env');
try {
  await access(target);
  process.stdout.write('server/.env already exists; left unchanged.\n');
  process.exit(0);
} catch {}

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
const activationCode = `local-${random(9)}`;
const content = [
  'HOST=127.0.0.1',
  'PORT=8787',
  'PUBLIC_BASE_URL=http://127.0.0.1:8787',
  `MASTER_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
  `ADMIN_API_KEY=${random()}`,
  `STUDENT_TOKEN_SECRET=${random()}`,
  `STUDENT_ACTIVATION_CODES=${activationCode}:local-student`,
  'STT_PROVIDER=mock',
  'SEED_ASR_API_KEY=',
  'SEED_ASR_RESOURCE_ID=volc.seedasr.sauc.duration',
  'SEED_ASR_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  'LLM_PROVIDER=codex-config',
  'CODEX_CONFIG_PATH=',
  'CODEX_AUTH_PATH=',
  'LLM_MODEL=gpt-5.6-sol',
  'LLM_ALLOWED_MODELS=gpt-5.6-sol,gpt-5.6-terra,gpt-5.5,gpt-5.4-mini',
  'LLM_REASONING_EFFORT=low',
  'LLM_ALLOWED_REASONING_EFFORTS=low,medium,high',
  '',
].join('\n');
await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`Created server/.env. Local activation code: ${activationCode}\n`);
