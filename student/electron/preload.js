const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('interviewAPI', {
  isE2E: process.env.STUDENT_E2E === '1',
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  testServer: () => ipcRenderer.invoke('server:test'),
  activate: (code) => ipcRenderer.invoke('student:activate', code),
  deactivate: () => ipcRenderer.invoke('student:deactivate'),
  startSession: (payload) => ipcRenderer.invoke('session:start', payload),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  triggerAnswer: () => ipcRenderer.invoke('answer:trigger'),
  sendAudioChunk: (channel, bytes) => ipcRenderer.send('audio:chunk', { channel, bytes }),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hide: () => ipcRenderer.invoke('window:hide'),
  onTranscript: (callback) => subscribe('transcript:update', callback),
  onAudioStatus: (callback) => subscribe('audio:status', callback),
  onAnswerStarted: (callback) => subscribe('answer:started', callback),
  onAnswerToken: (callback) => subscribe('answer:token', callback),
  onAnswerReplace: (callback) => subscribe('answer:replace', callback),
  onAnswerDone: (callback) => subscribe('answer:done', callback),
  onAnswerError: (callback) => subscribe('answer:error', callback),
});
