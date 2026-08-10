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
  assert.match(renderer, /elements\.supplement\.value = ''/);
  assert.doesNotMatch(renderer, /localStorage|sessionStorage|indexedDB/);
});

test('activation token uses Electron safeStorage and renderer never receives it', () => {
  const config = read('electron/config-store.js');
  assert.match(config, /safeStorage\.encryptString/);
  assert.match(config, /safeStorage\.decryptString/);
  const publicMethod = config.slice(config.indexOf('publicValue()'), config.indexOf('update(patch)'));
  assert.doesNotMatch(publicMethod, /activationToken:/);
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

test('system audio uses the packaged WASAPI helper instead of Chromium display capture', () => {
  const main = read('electron/main.js');
  const renderer = read('renderer/app.js');
  const nativeAudio = read('electron/native-audio.js');
  assert.match(main, /new NativeAudioCapture/);
  assert.match(main, /nativeAudio\.start\(\)/);
  assert.match(main, /InterviewAudioCapture\.exe/);
  assert.match(nativeAudio, /spawn\(this\.executablePath/);
  assert.doesNotMatch(main, /setDisplayMediaRequestHandler|desktopCapturer/);
  assert.doesNotMatch(renderer, /getDisplayMedia/);
});

test('transcripts stay on one visual line and answer rendering is frame-batched', () => {
  const renderer = read('renderer/app.js');
  const styles = read('renderer/styles.css');
  assert.doesNotMatch(renderer, /children\.length > 80/);
  assert.match(renderer, /event\.utteranceId/);
  assert.match(renderer, /requestAnimationFrame/);
  assert.match(styles, /\.transcript-item \.text \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
});
