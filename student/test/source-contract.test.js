const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('supplement is submitted only as session input and never persisted', () => {
  const config = read('electron/config-store.js');
  const renderer = read('renderer/app.js');
  assert.doesNotMatch(config, /supplement/i);
  assert.match(renderer, /startSession\(\{ supplement, microphoneEnabled \}\)/);
  assert.match(renderer, /updateSupplement\(''\)/);
  assert.doesNotMatch(renderer, /localStorage|sessionStorage|indexedDB/);
});

test('supplement supports 200,000 characters and local TXT or Markdown import', () => {
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  const renderer = read('renderer/app.js');
  const html = read('renderer/index.html');
  assert.match(main, /MAX_SUPPLEMENT_CHARS = 200_000/);
  assert.match(main, /extensions: \['txt', 'md'\]/);
  assert.match(main, /MAX_SUPPLEMENT_FILE_BYTES = 2 \* 1024 \* 1024/);
  assert.match(preload, /supplement:import/);
  assert.match(renderer, /MAX_SUPPLEMENT_CHARS = 200_000/);
  assert.match(renderer, /api\.importSupplement\(\)/);
  assert.match(html, /maxlength="200000"/);
});

test('activation token uses Electron safeStorage and renderer never receives it', () => {
  const config = read('electron/config-store.js');
  assert.match(config, /safeStorage\.encryptString/);
  assert.match(config, /safeStorage\.decryptString/);
  const publicMethod = config.slice(config.indexOf('publicValue()'), config.indexOf('update(patch)'));
  assert.doesNotMatch(publicMethod, /activationToken:/);
  assert.doesNotMatch(publicMethod, /serverUrl:/);
});

test('production service address is internal and not editable by the renderer', () => {
  const config = read('electron/config-store.js');
  const renderer = read('renderer/app.js');
  const html = read('renderer/index.html');
  assert.match(config, /https:\/\/119\.29\.213\.205/);
  assert.match(config, /process\.env\.INTERVIEW_SERVER_URL/);
  assert.doesNotMatch(renderer, /server-url|saveServerUrl/);
  assert.doesNotMatch(html, /server-url|服务地址/);
});

test('activation failures are translated without exposing internal error codes', () => {
  const main = read('electron/main.js');
  const client = read('electron/service-client.js');
  const renderer = read('renderer/app.js');
  assert.match(main, /activation_already_bound: '该激活码已绑定其他设备/);
  assert.match(main, /invalid_activation: '激活码无效/);
  assert.match(main, /throw new Error\(friendlyError\(error\)\)/);
  assert.match(client, /authorization-failed/);
  assert.match(main, /configStore\.clearActivationToken\(\)/);
  assert.match(renderer, /onConfigChanged/);
});

test('renderer is isolated and remote navigation is blocked', () => {
  const main = read('electron/main.js');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setContentProtection\(true\)/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-navigate/);
});

test('system audio uses platform-native helpers instead of Chromium display capture', () => {
  const main = read('electron/main.js');
  const renderer = read('renderer/app.js');
  const nativeAudio = read('electron/native-audio.js');
  const nativeAudioPath = read('electron/native-audio-path.js');
  assert.match(main, /new NativeAudioCapture/);
  assert.match(main, /nativeAudio\.start\(\)/);
  assert.match(nativeAudioPath, /InterviewAudioCapture\.exe/);
  assert.match(nativeAudioPath, /InterviewAudioCapture'/);
  assert.match(nativeAudio, /spawn\(this\.executablePath/);
  assert.doesNotMatch(main, /setDisplayMediaRequestHandler|desktopCapturer/);
  assert.doesNotMatch(renderer, /getDisplayMedia/);
});

test('macOS package declares native capture permissions and architecture-specific artifacts', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.build.mac.minimumSystemVersion, '13.0');
  assert.match(packageJson.build.mac.extendInfo.NSScreenCaptureUsageDescription, /系统声音/);
  assert.match(packageJson.build.mac.artifactName, /\$\{arch\}/);
  assert.match(read('native/AudioCapture.swift'), /ScreenCaptureKit/);
});

test('transcripts stay on one line while answer rendering is batched and preserves manual scrolling', () => {
  const renderer = read('renderer/app.js');
  const styles = read('renderer/styles.css');
  assert.doesNotMatch(renderer, /children\.length > 80/);
  assert.match(renderer, /event\.utteranceId/);
  assert.match(renderer, /requestAnimationFrame/);
  assert.match(renderer, /isAnswerOutputNearBottom/);
  assert.match(renderer, /followAnswerOutput\(shouldFollow\)/);
  assert.match(styles, /\.transcript-item \.text \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.match(styles, /\.answer-output \{[^}]*flex: 1 1 auto;[^}]*overflow-anchor: none;/s);
  assert.doesNotMatch(styles, /\.answer-output \{[^}]*max-height:/s);
});
