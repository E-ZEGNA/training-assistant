import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stdout.write(JSON.stringify({ ok: true, skipped: 'Windows only' }) + '\n');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const studentRoot = path.resolve(here, '..');
const projectRoot = path.resolve(studentRoot, '..');
const manifestPath = path.join(projectRoot, 'reports', 'interview-audio', 'manifest.json');
const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
const envText = await readFile(path.join(projectRoot, 'server', '.env'), 'utf8');
const activationCode = envText.match(/^STUDENT_ACTIVATION_CODES=([^:,]+):/m)?.[1];
if (!activationCode) throw new Error('Unable to read local activation code from server/.env');

const userData = await mkdtemp(path.join(os.tmpdir(), 'interview-audio-e2e-'));
const executablePath = process.env.PACKAGED_EXE;
if (!executablePath) throw new Error('PACKAGED_EXE must point to the installed student application');
const realStt = process.env.STT_REAL === '1';
const launchEnv = { ...process.env };
delete launchEnv.STUDENT_E2E;
const application = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userData}`],
  cwd: studentRoot,
  env: launchEnv,
  timeout: 30_000,
});

const results = [];
try {
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#connection-summary').getByText(/服务正常/).waitFor({ timeout: 15_000 });
  await page.locator('#activation-code').fill(activationCode);
  await page.locator('#activate-button').click();
  await page.locator('#activated-row').waitFor({ state: 'visible' });

  for (const question of manifest) {
    await page.locator('#supplement').fill(`音频回归样本：${question.id}`);
    await page.locator('#start-button').click();
    await page.locator('#meeting-view').waitFor({ state: 'visible', timeout: 15_000 });
    const audioDevice = await page.locator('#audio-state').getAttribute('title');
    const player = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(New-Object System.Media.SoundPlayer '${question.file.replaceAll("'", "''")}').PlaySync()`,
    ], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      player.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Playback failed for ${question.id} (${code})`)));
      player.once('error', reject);
    });
    let transcript;
    if (realStt) {
      await page.locator('.transcript-item .text').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      await page.locator('#transcript-state').getByText('已确认').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
      transcript = await page.locator('.transcript-item .text').allTextContents();
    } else {
      await page.locator('.transcript-item .text').getByText('本地模拟转写：已收到音频。').waitFor({ timeout: 15_000 });
      transcript = ['本地模拟转写：已收到音频。'];
    }
    results.push({ id: question.id, bytes: question.bytes, audioDevice, transportConfirmed: true, transcript });
    await page.locator('#stop-button').click();
    await page.locator('#setup-view').waitFor({ state: 'visible' });
  }
} finally {
  await application.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({ ok: true, cases: results }, null, 2) + '\n');
