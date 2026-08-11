const path = require('node:path');

function nativeAudioPath({ platform, packaged, resourcesPath, appDirectory }) {
  let executable;
  if (platform === 'win32') executable = 'InterviewAudioCapture.exe';
  else if (platform === 'darwin') executable = 'InterviewAudioCapture';
  else throw new Error(`Unsupported system-audio platform: ${platform}`);

  return packaged
    ? path.join(resourcesPath, 'native', executable)
    : path.join(appDirectory, '..', 'native', 'bin', executable);
}

module.exports = { nativeAudioPath };
