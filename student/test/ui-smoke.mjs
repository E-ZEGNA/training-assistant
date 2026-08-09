import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const studentRoot = path.resolve(here, '..');
const projectRoot = path.resolve(studentRoot, '..');
const userData = await mkdtemp(path.join(os.tmpdir(), 'interview-student-ui-'));
const reports = path.join(projectRoot, 'reports');
await mkdir(reports, { recursive: true });

const envText = await readFile(path.join(projectRoot, 'server', '.env'), 'utf8');
const activationCode = envText.match(/^STUDENT_ACTIVATION_CODES=([^:,]+):/m)?.[1];
if (!activationCode) throw new Error('Unable to read local activation code from server/.env');

const pageErrors = [];
const packagedExecutable = process.env.PACKAGED_EXE;
const realAudio = process.env.STUDENT_REAL_AUDIO === '1';
const launchEnv = { ...process.env };
if (realAudio) delete launchEnv.STUDENT_E2E;
else launchEnv.STUDENT_E2E = '1';
const application = await electron.launch({
  executablePath: packagedExecutable || require('electron'),
  args: packagedExecutable ? [`--user-data-dir=${userData}`] : [studentRoot, `--user-data-dir=${userData}`],
  cwd: studentRoot,
  env: launchEnv,
  timeout: 30_000,
});

try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#connection-summary').getByText(/服务正常/).waitFor({ timeout: 15_000 });
  await page.locator('#start-requirement').getByText('请先输入激活码并完成激活').waitFor();
  if (!(await page.locator('#start-button').isDisabled())) throw new Error('Start button must stay disabled before activation');

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 760));
  await page.screenshot({ path: path.join(reports, 'student-setup-560.png') });

  await page.locator('#activation-code').fill(activationCode);
  await page.locator('#activate-button').click();
  await page.locator('#activated-row').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('start-button')?.disabled === false, null, { timeout: 15_000 });
  await page.locator('#start-requirement').getByText('准备完成，可以开始面试').waitFor();
  await page.locator('#supplement').fill('本场应聘 ML Infra，重点考察 GPU 调度与训练稳定性。');
  await page.locator('#start-button').click();
  await page.locator('#meeting-view').waitFor({ state: 'visible', timeout: 15_000 });
  if (realAudio) {
    const player = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      "(New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav').PlaySync()",
    ], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      player.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Test sound failed (${code})`)));
      player.once('error', reject);
    });
    await page.locator('.transcript-item .text').getByText('本地模拟转写：已收到音频。').waitFor({ timeout: 15_000 });
  }
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('transcript:update', { channel: 'system', text: '问题第一段', final: true });
    contents.send('transcript:update', { channel: 'system', text: '问题第二段', final: true });
    contents.send('answer:started', { source: 'test' });
    contents.send('answer:token', { token: '第一题的建议回答会继续保留。' });
    contents.send('answer:done', { answer: '第一题的建议回答会继续保留。' });
    contents.send('answer:started', { source: 'test' });
    contents.send('answer:token', { token: '第二题正在通过流式事件追加。' });
    contents.send('answer:done', { answer: '第二题正在通过流式事件追加。' });
  });
  await page.locator('.transcript-item.system .text').first().waitFor();
  const transcriptLine = await page.locator('.transcript-item.system .text').first().textContent();
  if (transcriptLine !== '问题第一段问题第二段') throw new Error(`Transcript segments were not merged: ${transcriptLine}`);
  await page.locator('.answer-item').nth(1).getByText('第二题正在通过流式事件追加。').waitFor();
  if (await page.locator('.answer-item').count() !== 2) throw new Error('Previous answers must remain visible');
  await page.locator('.answer-item').first().getByText('第一题的建议回答会继续保留。').waitFor();
  await page.screenshot({ path: path.join(reports, 'student-meeting-560.png') });

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(430, 700));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(reports, 'student-meeting-430.png') });

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    bodyScrollWidth: document.body.scrollWidth,
    answerWidth: document.getElementById('answer-output').getBoundingClientRect().width,
    buttonWidth: document.getElementById('answer-button').getBoundingClientRect().width,
  }));
  if (layout.bodyScrollWidth > layout.viewportWidth + 1) throw new Error(`Horizontal overflow: ${JSON.stringify(layout)}`);
  if (layout.answerWidth <= 0 || layout.buttonWidth <= 0) throw new Error(`Primary meeting controls are not visible: ${JSON.stringify(layout)}`);
  if (pageErrors.length) throw new Error(`Renderer errors: ${pageErrors.join('; ')}`);

  await page.locator('#stop-button').click();
  await page.locator('#setup-view').waitFor({ state: 'visible' });
  process.stdout.write(`${JSON.stringify({ ok: true, screenshots: ['student-setup-560.png', 'student-meeting-560.png', 'student-meeting-430.png'], layout })}\n`);
} finally {
  await application.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}
