const { app, BrowserWindow, globalShortcut, ipcMain, session } = require('electron');
const path = require('node:path');
const { ConfigStore } = require('./config-store');
const { ServiceClient, ServiceError } = require('./service-client');
const { NativeAudioCapture } = require('./native-audio');

let mainWindow = null;
let configStore = null;
let serviceClient = null;
let nativeAudio = null;
let answerInFlight = false;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 420,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7f8',
    title: '面试助教',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.setContentProtection(true);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function configureMediaCapture() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const ownPage = webContents.getURL().startsWith('file:');
    callback(ownPage && permission === 'media');
  });
}

function nativeAudioPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'InterviewAudioCapture.exe')
    : path.join(__dirname, '..', 'native', 'bin', 'InterviewAudioCapture.exe');
}

function registerAnswerHotkey(accelerator, previous) {
  if (previous) globalShortcut.unregister(previous);
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, () => triggerAnswer('hotkey'));
  } catch {
    ok = false;
  }
  if (!ok && previous) globalShortcut.register(previous, () => triggerAnswer('hotkey'));
  return ok;
}

async function triggerAnswer(source) {
  if (answerInFlight || !serviceClient?.sessionId) return;
  if (source === 'hotkey' && mainWindow && !mainWindow.isVisible()) mainWindow.showInactive();
  answerInFlight = true;
  send('answer:started', { source });
  try {
    await serviceClient.answer();
  } catch (error) {
    if (error?.name !== 'AbortError') send('answer:error', { message: friendlyError(error) });
  } finally {
    answerInFlight = false;
  }
}

function friendlyError(error) {
  const mapping = {
    invalid_activation: '激活码无效，请检查后重新输入。',
    activation_already_bound: '该激活码已绑定其他设备或网络，请联系发布方重置。',
    activation_revoked: '该激活码已停用，请联系发布方。',
    too_many_attempts: '激活尝试过于频繁，请稍后再试。',
    no_transcript_yet: '还没有识别到面试官的问题，请等转写出现后再试。',
    answer_rate_limited: '请求过于频繁，请稍后再试。',
    answer_generation_failed: '模型生成失败，请稍后重试。',
    answer_stream_interrupted: '回答传输中断，请重新生成。',
    session_not_found: '本场会话已过期，请结束后重新开始。',
    unauthorized: '激活状态已失效，请重新激活。',
  };
  if (error instanceof ServiceError && mapping[error.code]) return mapping[error.code];
  return error?.message || '服务暂时不可用，请检查网络后重试。';
}

function wireClientEvents() {
  serviceClient.on('transcript', (event) => send('transcript:update', event));
  serviceClient.on('status', (event) => send('audio:status', event));
  serviceClient.on('answer-token', (event) => send('answer:token', event));
  serviceClient.on('answer-replace', (event) => send('answer:replace', event));
  serviceClient.on('answer-done', (event) => send('answer:done', event));
}

function registerIpc() {
  ipcMain.handle('config:get', () => configStore.publicValue());
  ipcMain.handle('config:update', (_event, patch) => {
    const previous = configStore.value.answerHotkey;
    if (typeof patch?.answerHotkey === 'string' && patch.answerHotkey !== previous) {
      if (!registerAnswerHotkey(patch.answerHotkey, previous)) throw new Error('该快捷键已被系统或其他应用占用');
    }
    return configStore.update(patch ?? {});
  });
  ipcMain.handle('server:test', async () => {
    const health = await serviceClient.health();
    return { ok: health.ok, masterPackConfigured: health.masterPackConfigured };
  });
  ipcMain.handle('student:activate', async (_event, code) => {
    try {
      const result = await serviceClient.activate(String(code ?? '').trim(), configStore.value.deviceId);
      configStore.setActivationToken(result.token);
      return { activated: true, studentId: result.studentId };
    } catch (error) {
      throw new Error(friendlyError(error));
    }
  });
  ipcMain.handle('student:deactivate', async () => {
    await serviceClient.stopSession();
    configStore.clearActivationToken();
    return configStore.publicValue();
  });
  ipcMain.handle('session:start', async (_event, payload) => {
    const supplement = String(payload?.supplement ?? '');
    const microphoneEnabled = payload?.microphoneEnabled === true;
    const result = await serviceClient.startSession(supplement);
    try {
      const audio = process.env.STUDENT_E2E === '1' ? null : await nativeAudio.start();
      if (microphoneEnabled) serviceClient.enableMicrophone();
      mainWindow?.setAlwaysOnTop(true, 'floating');
      return { ...result, audioDevice: audio?.device ?? '' };
    } catch (error) {
      await nativeAudio.stop();
      await serviceClient.stopSession();
      throw error;
    }
  });
  ipcMain.handle('session:stop', async () => {
    await nativeAudio.stop();
    await serviceClient.stopSession();
    answerInFlight = false;
    mainWindow?.setAlwaysOnTop(false);
    return { ok: true };
  });
  ipcMain.handle('answer:trigger', () => triggerAnswer('button'));
  ipcMain.on('audio:chunk', (_event, payload) => {
    const channel = payload?.channel;
    if (channel !== 'system' && channel !== 'mic') return;
    if (!(payload.bytes instanceof Uint8Array) || payload.bytes.byteLength > 16 * 1024) return;
    serviceClient.sendAudio(channel, payload.bytes);
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:hide', () => mainWindow?.hide());
}

app.whenReady().then(async () => {
  app.setAppUserModelId('cn.internal.interviewassistant');
  configStore = new ConfigStore();
  serviceClient = new ServiceClient(configStore);
  nativeAudio = new NativeAudioCapture(nativeAudioPath());
  nativeAudio.on('audio', (bytes) => serviceClient.sendAudio('system', bytes));
  nativeAudio.on('status', (event) => send('audio:status', { channel: 'system', ...event }));
  wireClientEvents();
  await configureMediaCapture();
  registerIpc();
  createWindow();
  registerAnswerHotkey(configStore.value.answerHotkey);
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  nativeAudio?.stop().catch(() => {});
  serviceClient?.stopSession().catch(() => {});
});
