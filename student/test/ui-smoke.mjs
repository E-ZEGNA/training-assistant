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
launchEnv.INTERVIEW_SERVER_URL ||= envText.match(/^PUBLIC_BASE_URL=(.+)$/m)?.[1] ?? 'http://127.0.0.1:8787';
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
  try {
    await page.locator('#activated-row').waitFor({ state: 'visible' });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      connection: document.getElementById('connection-summary')?.textContent,
      header: document.getElementById('header-status')?.textContent,
      requirement: document.getElementById('start-requirement')?.textContent,
      toast: document.getElementById('toast')?.textContent,
    }));
    throw new Error(`Activation UI failed: ${JSON.stringify(diagnostics)}; ${error.message}`);
  }
  await page.waitForFunction(() => document.getElementById('start-button')?.disabled === false, null, { timeout: 15_000 });
  await page.locator('#start-requirement').getByText('准备完成，可以开始面试').waitFor();
  const selectedModel = await page.locator('#model-select').inputValue();
  if (!selectedModel || await page.locator('#model-select option').count() < 1) throw new Error('Model selector did not load');
  const selectedReasoning = await page.locator('#reasoning-select').inputValue();
  if (!selectedReasoning || await page.locator('#reasoning-select option').count() < 1) throw new Error('Reasoning selector did not load');
  await page.screenshot({ path: path.join(reports, 'student-setup-active-560.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(430, 620));
  await page.waitForTimeout(100);
  const narrowSetup = await page.evaluate(() => {
    const model = document.getElementById('model-select').getBoundingClientRect();
    const reasoning = document.getElementById('reasoning-select').getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      modelLeft: model.left,
      modelRight: model.right,
      reasoningLeft: reasoning.left,
      reasoningRight: reasoning.right,
    };
  });
  if (narrowSetup.bodyScrollWidth > narrowSetup.viewportWidth + 1
    || narrowSetup.modelRight > narrowSetup.viewportWidth + 1
    || narrowSetup.reasoningRight > narrowSetup.viewportWidth + 1) {
    throw new Error(`Runtime selectors overflow the narrow setup view: ${JSON.stringify(narrowSetup)}`);
  }
  await page.screenshot({ path: path.join(reports, 'student-setup-active-430.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 760));
  await page.locator('#supplement').fill('本场应聘 ML Infra，重点考察 GPU 调度与训练稳定性。');
  await page.locator('#start-button').click();
  try {
    await page.locator('#meeting-view').waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      connection: document.getElementById('connection-summary')?.textContent,
      header: document.getElementById('header-status')?.textContent,
      requirement: document.getElementById('start-requirement')?.textContent,
      toast: document.getElementById('toast')?.textContent,
    }));
    throw new Error(`Meeting UI failed to start: ${JSON.stringify(diagnostics)}; ${error.message}`);
  }
  const answerEmptyAlignment = await page.evaluate(() => {
    const panel = document.getElementById('answer-output').getBoundingClientRect();
    const empty = document.querySelector('#answer-output > .empty-state').getBoundingClientRect();
    return {
      horizontal: Math.abs((panel.left + panel.width / 2) - (empty.left + empty.width / 2)),
      vertical: Math.abs((panel.top + panel.height / 2) - (empty.top + empty.height / 2)),
    };
  });
  if (answerEmptyAlignment.horizontal > 1 || answerEmptyAlignment.vertical > 1) {
    throw new Error(`Answer empty state is not centered: ${JSON.stringify(answerEmptyAlignment)}`);
  }
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
    for (let index = 0; index < 120; index += 1) {
      contents.send('answer:token', { token: index === 0 ? '第一题' : '流' });
      if (index === 40) {
        contents.send('transcript:update', {
          channel: 'system', utteranceId: 'during-answer', text: '生成回答期间转写仍然继续', final: false,
        });
      }
    }
    contents.send('answer:done', { answer: '第一题的建议回答会继续保留。' });
    contents.send('answer:started', { source: 'test' });
    contents.send('answer:token', { token: '第二题正在通过流式事件追加。' });
    contents.send('answer:done', { answer: '第二题正在通过流式事件追加。' });
    for (let index = 0; index < 105; index += 1) {
      contents.send('transcript:update', {
        channel: 'system', utteranceId: `history-${index}`, text: `完整转写记录 ${index}：这是一段需要保留的较长内容。`, final: false,
      });
    }
    contents.send('transcript:update', { channel: 'system', utteranceId: 'revised-utterance', text: '重复测试初稿', final: true });
    contents.send('transcript:update', { channel: 'system', utteranceId: 'revised-utterance', text: '重复测试最终稿', final: true });
  });
  await page.locator('.transcript-item.system .text').first().waitFor();
  const transcriptLine = await page.locator('.transcript-item.system .text').first().textContent();
  if (transcriptLine !== '问题第一段问题第二段') throw new Error(`Transcript segments were not merged: ${transcriptLine}`);
  await page.locator('.answer-item').nth(1).getByText('第二题正在通过流式事件追加。').waitFor();
  if (await page.locator('.answer-item').count() !== 2) throw new Error('Previous answers must remain visible');
  await page.locator('.answer-item').first().getByText(/^第一题流+$/).waitFor();
  await page.locator('.transcript-item .text').getByText('生成回答期间转写仍然继续').waitFor();
  if (await page.locator('.transcript-item').count() < 3) throw new Error('Answer-triggered transcript boundaries were not preserved');
  const transcriptBlocks = await page.locator('.transcript-item .text').allTextContents();
  if (!transcriptBlocks.some((text) => text.includes('完整转写记录 0') && text.includes('完整转写记录 104'))) {
    throw new Error('Current answer segment did not retain its full transcript');
  }
  const revisedText = await page.locator('.transcript-item .text').evaluateAll((nodes) => nodes.map((node) => node.textContent).filter((text) => text.includes('重复测试')));
  if (revisedText.length !== 1 || revisedText[0].includes('重复测试初稿') || !revisedText[0].endsWith('重复测试最终稿')) {
    throw new Error(`Final utterance revision was duplicated: ${JSON.stringify(revisedText)}`);
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('audio:status', {
    channel: 'mic', state: 'failed', error: '麦克风测试失败',
  }));
  await page.locator('#audio-state').getByText(/系统音频.*麦克风转写暂不可用/).waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('audio:status', {
    channel: 'system', state: 'failed', error: '系统声道测试失败',
  }));
  await page.locator('#audio-state').getByText('系统音频转写暂不可用').waitFor();
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('audio:status', { channel: 'system', state: 'connected' });
    contents.send('audio:status', { channel: 'mic', state: 'connected' });
    contents.send('transcript:update', { channel: 'system', utteranceId: 'english-a', text: 'Please explain Java', final: true });
    contents.send('transcript:update', { channel: 'system', utteranceId: 'english-b', text: 'Please explain JavaScript', final: true });
  });
  const transcriptWhiteSpace = await page.locator('.transcript-item .text').last().evaluate((node) => getComputedStyle(node).whiteSpace);
  if (transcriptWhiteSpace !== 'nowrap') throw new Error('Transcript text must stay on one visual line');
  const englishTranscript = await page.locator('.transcript-item .text').last().textContent();
  if (!englishTranscript.includes('Please explain Java Please explain JavaScript')) {
    throw new Error(`Distinct English utterances were lost or joined without spacing: ${englishTranscript}`);
  }

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 760));
  await page.waitForTimeout(100);
  const compactLayout = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    answerHeight: document.getElementById('answer-output').getBoundingClientRect().height,
    buttonBottom: document.getElementById('answer-button').getBoundingClientRect().bottom,
  }));
  const compactAnswerHeight = compactLayout.answerHeight;
  if (compactLayout.buttonBottom > compactLayout.viewportHeight + 1) {
    throw new Error(`Answer controls overflow the compact window: ${JSON.stringify(compactLayout)}`);
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(560, 960));
  await page.waitForTimeout(100);
  const expandedLayout = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    answerHeight: document.getElementById('answer-output').getBoundingClientRect().height,
    buttonBottom: document.getElementById('answer-button').getBoundingClientRect().bottom,
  }));
  const expandedAnswerHeight = expandedLayout.answerHeight;
  if (expandedAnswerHeight < compactAnswerHeight + 120) {
    throw new Error(`Answer output did not adapt to taller windows: ${JSON.stringify({ compactAnswerHeight, expandedAnswerHeight })}`);
  }
  if (expandedLayout.buttonBottom > expandedLayout.viewportHeight + 1) {
    throw new Error(`Answer controls overflow the expanded window: ${JSON.stringify(expandedLayout)}`);
  }

  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('answer:started', { source: 'scroll-test' });
    contents.send('answer:token', { token: Array.from({ length: 80 }, (_, index) => `滚动测试内容 ${index}`).join('\n') });
  });
  await page.waitForFunction(() => document.querySelectorAll('.answer-item').length === 3 && document.querySelector('.answer-item:last-child .answer-text')?.textContent.includes('滚动测试内容 79'));
  const answerOutput = page.locator('#answer-output');
  await answerOutput.evaluate((node) => { node.scrollTop = 0; });
  const manualScrollTop = await answerOutput.evaluate((node) => node.scrollTop);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('answer:token', { token: '\n用户阅读上文时到达的新内容' });
  });
  await page.locator('.answer-item').last().getByText(/用户阅读上文时到达的新内容/).waitFor();
  const preservedScrollTop = await answerOutput.evaluate((node) => node.scrollTop);
  if (Math.abs(preservedScrollTop - manualScrollTop) > 1) {
    throw new Error(`Streaming answer overrode manual scrolling: ${JSON.stringify({ manualScrollTop, preservedScrollTop })}`);
  }
  await answerOutput.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('answer:token', { token: '\n回到底部后继续自动跟随' });
    contents.send('answer:done', { answer: 'scroll-test' });
  });
  await page.locator('.answer-item').last().getByText(/回到底部后继续自动跟随/).waitFor();
  const bottomDistance = await answerOutput.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  if (bottomDistance > 2) throw new Error(`Answer output stopped following at the bottom: ${bottomDistance}`);
  await page.screenshot({ path: path.join(reports, 'student-meeting-560.png') });

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(430, 700));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(reports, 'student-meeting-430.png') });

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(430, 620));
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
    answerWidth: document.getElementById('answer-output').getBoundingClientRect().width,
    buttonWidth: document.getElementById('answer-button').getBoundingClientRect().width,
    buttonBottom: document.getElementById('answer-button').getBoundingClientRect().bottom,
  }));
  layout.compactAnswerHeight = compactAnswerHeight;
  layout.expandedAnswerHeight = expandedAnswerHeight;
  if (layout.bodyScrollWidth > layout.viewportWidth + 1) throw new Error(`Horizontal overflow: ${JSON.stringify(layout)}`);
  if (layout.answerWidth <= 0 || layout.buttonWidth <= 0) throw new Error(`Primary meeting controls are not visible: ${JSON.stringify(layout)}`);
  if (layout.buttonBottom > layout.viewportHeight + 1 || layout.bodyScrollHeight > layout.viewportHeight + 1) {
    throw new Error(`Meeting controls overflow the narrow window: ${JSON.stringify(layout)}`);
  }
  if (pageErrors.length) throw new Error(`Renderer errors: ${pageErrors.join('; ')}`);

  await page.locator('#stop-button').click();
  await page.locator('#setup-view').waitFor({ state: 'visible' });
  process.stdout.write(`${JSON.stringify({ ok: true, screenshots: ['student-setup-560.png', 'student-setup-active-560.png', 'student-setup-active-430.png', 'student-meeting-560.png', 'student-meeting-430.png'], narrowSetup, layout })}\n`);
} finally {
  await application.close().catch(() => {});
  await rm(userData, { recursive: true, force: true });
}
