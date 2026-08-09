import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stdout.write(JSON.stringify({ ok: true, skipped: 'Windows only' }) + '\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.resolve(here, '..', 'native', 'bin', 'InterviewAudioCapture.exe');
const testSound = 'C:\\Windows\\Media\\Alarm01.wav';
if (!existsSync(helper)) throw new Error(`Native audio helper is missing: ${helper}`);
if (!existsSync(testSound)) throw new Error(`Windows test sound is missing: ${testSound}`);

const capture = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const chunks = [];
let stderr = '';
capture.stdout.on('data', (chunk) => chunks.push(chunk));
capture.stderr.setEncoding('utf8');
capture.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitForReady() {
  const started = Date.now();
  while (!stderr.includes('"event":"ready"')) {
    if (capture.exitCode !== null) throw new Error(`Audio helper exited early (${capture.exitCode}): ${stderr}`);
    if (Date.now() - started > 8_000) throw new Error(`Audio helper did not become ready: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

try {
  await waitForReady();
  const player = spawn('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(New-Object System.Media.SoundPlayer '${testSound}').PlaySync()`,
  ], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    player.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Test sound failed (${code})`)));
    player.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
} finally {
  capture.stdin.end();
  await new Promise((resolve) => {
    if (capture.exitCode !== null) return resolve();
    const timer = setTimeout(() => { capture.kill(); resolve(); }, 3_000);
    capture.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

const pcm = Buffer.concat(chunks);
let squareSum = 0;
let peak = 0;
const sampleCount = Math.floor(pcm.length / 2);
for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
  const sample = pcm.readInt16LE(offset) / 32768;
  squareSum += sample * sample;
  peak = Math.max(peak, Math.abs(sample));
}
const rms = sampleCount ? Math.sqrt(squareSum / sampleCount) : 0;
const ready = stderr.split(/\r?\n/).find((line) => line.includes('"event":"ready"'));
if (pcm.length < 6400 || rms < 0.001 || peak < 0.005) {
  throw new Error(`No usable loopback signal: ${JSON.stringify({ bytes: pcm.length, rms, peak, ready, stderr })}`);
}
process.stdout.write(JSON.stringify({ ok: true, bytes: pcm.length, rms, peak, ready: JSON.parse(ready) }) + '\n');
