const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nativeAudioPath } = require('../electron/native-audio-path');

test('resolves packaged Windows and macOS native helpers', () => {
  assert.equal(
    nativeAudioPath({ platform: 'win32', packaged: true, resourcesPath: 'R', appDirectory: 'A' }),
    path.join('R', 'native', 'InterviewAudioCapture.exe')
  );
  assert.equal(
    nativeAudioPath({ platform: 'darwin', packaged: true, resourcesPath: 'R', appDirectory: 'A' }),
    path.join('R', 'native', 'InterviewAudioCapture')
  );
});

test('rejects unsupported system-audio platforms', () => {
  assert.throws(
    () => nativeAudioPath({ platform: 'linux', packaged: false, resourcesPath: 'R', appDirectory: 'A' }),
    /Unsupported system-audio platform/
  );
});
