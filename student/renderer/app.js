const api = window.interviewAPI;

const elements = Object.fromEntries([
  'header-status', 'setup-view', 'meeting-view', 'connection-summary', 'server-url', 'test-server',
  'activation-field', 'activation-code', 'activate-button', 'activated-row', 'deactivate-button',
  'supplement', 'supplement-count', 'microphone-enabled', 'hotkey-recorder', 'start-button',
  'start-requirement',
  'audio-state', 'transcript-state', 'transcript-list', 'answer-state', 'answer-output',
  'answer-button', 'answer-hotkey-label', 'stop-button', 'minimize-button', 'hide-button', 'toast',
].map((id) => [id, document.getElementById(id)]));

const state = {
  config: null,
  connected: false,
  masterPackConfigured: false,
  meeting: false,
  answerPending: false,
  answerCount: 0,
  currentAnswerNode: null,
  answerTokenBuffer: '',
  answerRenderFrame: null,
  captures: new Map(),
  transcriptSegments: [],
  activeTranscriptSegment: null,
  audioStatus: { system: 'idle', mic: 'disabled' },
  audioErrors: {},
  audioDeviceLabel: '系统音频已连接',
};

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function showToast(message, type = 'normal') {
  elements.toast.textContent = message;
  elements.toast.className = `toast${type === 'error' ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add('hidden'), 3600);
}

function errorMessage(error) {
  return String(error?.message ?? error ?? '操作失败').replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
}

function displayHotkey(accelerator) {
  return accelerator
    .replace('CommandOrControl', 'Ctrl')
    .replaceAll('+', ' + ')
    .replace('Arrow', '');
}

function renderConfig() {
  elements['server-url'].value = state.config.serverUrl;
  elements['microphone-enabled'].checked = state.config.microphoneEnabled;
  const hotkey = displayHotkey(state.config.answerHotkey);
  elements['hotkey-recorder'].textContent = hotkey;
  elements['answer-hotkey-label'].textContent = hotkey;
  elements['activation-field'].classList.toggle('hidden', state.config.activated);
  elements['activated-row'].classList.toggle('hidden', !state.config.activated);
  updateStartState();
}

function updateStartState() {
  const ready = Boolean(state.config?.activated && state.connected && state.masterPackConfigured);
  elements['start-button'].disabled = !ready;
  elements['start-requirement'].classList.toggle('ready', ready);
  if (!state.config?.activated) {
    elements['start-requirement'].textContent = '请先输入激活码并完成激活';
  } else if (!state.connected) {
    elements['start-requirement'].textContent = '机构服务未连接，请点击上方“测试”';
  } else if (!state.masterPackConfigured) {
    elements['start-requirement'].textContent = '机构资料尚未就绪，请联系发布方';
  } else {
    elements['start-requirement'].textContent = '准备完成，可以开始面试';
  }
}

async function saveServerUrl() {
  const serverUrl = elements['server-url'].value.trim();
  state.config = await api.updateConfig({ serverUrl });
  renderConfig();
}

async function testServer() {
  elements['test-server'].disabled = true;
  elements['connection-summary'].textContent = '正在连接';
  try {
    await saveServerUrl();
    const result = await api.testServer();
    state.connected = result.ok;
    state.masterPackConfigured = result.masterPackConfigured;
    elements['connection-summary'].textContent = result.masterPackConfigured ? '服务正常，机构资料已就绪' : '服务正常，机构资料尚未就绪';
    elements['header-status'].textContent = result.masterPackConfigured ? '服务已连接' : '等待机构资料';
    if (!result.masterPackConfigured) showToast('机构资料尚未就绪', 'error');
  } catch (error) {
    state.connected = false;
    state.masterPackConfigured = false;
    elements['connection-summary'].textContent = '连接失败';
    elements['header-status'].textContent = '服务不可用';
    showToast(errorMessage(error), 'error');
  } finally {
    elements['test-server'].disabled = false;
    updateStartState();
  }
}

async function activate() {
  const code = elements['activation-code'].value.trim();
  if (!code) return showToast('请输入激活码', 'error');
  elements['activate-button'].disabled = true;
  try {
    await saveServerUrl();
    await api.activate(code);
    state.config = await api.getConfig();
    elements['activation-code'].value = '';
    renderConfig();
    showToast('激活成功');
    await testServer();
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    elements['activate-button'].disabled = false;
  }
}

class PcmCapture {
  constructor(channel) {
    this.channel = channel;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.node = null;
    this.silentGain = null;
  }

  async start() {
    if (api.isE2E) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (!this.stream.getAudioTracks().length) {
      this.stop();
      throw new Error('未获取到麦克风音频');
    }
    this.context = new AudioContext({ latencyHint: 'interactive' });
    await this.context.audioWorklet.addModule('pcm-worklet.js');
    this.source = this.context.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    this.node = new AudioWorkletNode(this.context, 'pcm16-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: 16000, packetSamples: 3200 },
    });
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.node.port.onmessage = ({ data }) => api.sendAudioChunk(this.channel, new Uint8Array(data));
    this.source.connect(this.node);
    this.node.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
    await this.context.resume();
  }

  stop() {
    this.node?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.context?.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}

async function startCapture(channel) {
  const capture = new PcmCapture(channel);
  await capture.start();
  state.captures.set(channel, capture);
}

function stopCaptures() {
  for (const capture of state.captures.values()) capture.stop();
  state.captures.clear();
}

function flushAnswerTokens() {
  if (state.answerRenderFrame !== null) cancelAnimationFrame(state.answerRenderFrame);
  state.answerRenderFrame = null;
  const token = state.answerTokenBuffer;
  state.answerTokenBuffer = '';
  if (!token || !state.currentAnswerNode) return;
  state.currentAnswerNode.querySelector('.answer-text').textContent += token;
  elements['answer-output'].scrollTop = elements['answer-output'].scrollHeight;
}

function scheduleAnswerTokenFlush() {
  if (state.answerRenderFrame !== null) return;
  state.answerRenderFrame = requestAnimationFrame(() => {
    state.answerRenderFrame = null;
    flushAnswerTokens();
  });
}

function resetAnswerTokenBuffer() {
  if (state.answerRenderFrame !== null) cancelAnimationFrame(state.answerRenderFrame);
  state.answerRenderFrame = null;
  state.answerTokenBuffer = '';
}

function resetMeetingUi() {
  resetAnswerTokenBuffer();
  state.transcriptSegments = [];
  state.activeTranscriptSegment = null;
  state.answerCount = 0;
  state.currentAnswerNode = null;
  elements['transcript-list'].innerHTML = '<div class="empty-state"><i data-lucide="waves"></i><span>等待面试官声音</span></div>';
  elements['answer-output'].innerHTML = '<div class="empty-state"><i data-lucide="sparkles"></i><span>答案将在这里出现</span></div>';
  elements['answer-output'].classList.remove('generating');
  elements['answer-state'].textContent = '就绪';
  elements['transcript-state'].textContent = '等待声音';
  refreshIcons();
}

function beginTranscriptSegment() {
  state.activeTranscriptSegment = null;
}

function renderAudioStatus() {
  const systemState = state.audioStatus.system;
  const micState = state.audioStatus.mic;
  let text = state.audioDeviceLabel;
  if (systemState === 'failed') text = '系统音频转写暂不可用';
  else if (systemState === 'reconnecting') text = '系统音频网络重连中';
  else if (micState === 'failed') text = `${state.audioDeviceLabel}；麦克风转写暂不可用`;
  else if (micState === 'reconnecting') text = `${state.audioDeviceLabel}；麦克风网络重连中`;
  else if (micState === 'connected') text = `${state.audioDeviceLabel} + 麦克风`;
  elements['audio-state'].textContent = text;
  elements['audio-state'].title = state.audioErrors.system ?? state.audioErrors.mic ?? text;
}

async function startMeeting() {
  if (state.meeting) return;
  elements['start-button'].disabled = true;
  const supplement = elements.supplement.value;
  const microphoneEnabled = elements['microphone-enabled'].checked;
  try {
    state.audioStatus = { system: 'connecting', mic: microphoneEnabled ? 'connecting' : 'disabled' };
    state.audioErrors = {};
    state.config = await api.updateConfig({ microphoneEnabled });
    const session = await api.startSession({ supplement, microphoneEnabled });
    elements.supplement.value = '';
    elements['supplement-count'].textContent = '0 / 30000';
    if (microphoneEnabled) {
      try {
        await startCapture('mic');
      } catch (error) {
        showToast(`麦克风未启用：${errorMessage(error)}`, 'error');
      }
    }
    state.meeting = true;
    resetMeetingUi();
    elements['setup-view'].classList.add('hidden');
    elements['meeting-view'].classList.remove('hidden');
    elements['header-status'].textContent = '面试进行中';
    state.audioDeviceLabel = session.audioDevice ? `系统音频：${session.audioDevice}` : '系统音频已连接';
    renderAudioStatus();
  } catch (error) {
    stopCaptures();
    showToast(errorMessage(error), 'error');
    updateStartState();
  }
}

async function stopMeeting() {
  if (!state.meeting) return;
  elements['stop-button'].disabled = true;
  stopCaptures();
  try {
    await api.stopSession();
  } finally {
    state.meeting = false;
    state.answerPending = false;
    elements['meeting-view'].classList.add('hidden');
    elements['setup-view'].classList.remove('hidden');
    elements['header-status'].textContent = state.connected ? '服务已连接' : '待连接';
    elements['stop-button'].disabled = false;
    updateStartState();
  }
}

function renderTranscript(event) {
  const empty = elements['transcript-list'].querySelector('.empty-state');
  empty?.remove();
  const channel = event.channel === 'mic' ? 'mic' : 'system';
  const text = String(event.text ?? '').trim();
  if (!text) return;
  let segment = state.activeTranscriptSegment;
  if (!segment) {
    segment = { blocks: new Map(), entries: [], entriesByKey: new Map() };
    state.transcriptSegments.push(segment);
    state.activeTranscriptSegment = segment;
  }
  const hasUtteranceId = event.utteranceId != null;
  const utteranceKey = `${channel}:${hasUtteranceId ? event.utteranceId : 'current'}`;
  let entry = segment.entriesByKey.get(utteranceKey);
  if (!hasUtteranceId && entry?.final) entry = null;
  if (!entry) {
    entry = { channel, text, final: event.final === true };
    segment.entries.push(entry);
    segment.entriesByKey.set(utteranceKey, entry);
  } else {
    entry.text = text;
    entry.final = event.final === true;
  }
  if (!hasUtteranceId && entry.final) segment.entriesByKey.delete(utteranceKey);
  let block = segment.blocks.get(channel);
  if (!block) {
    const node = document.createElement('div');
    node.className = `transcript-item ${channel}`;
    node.innerHTML = '<span class="speaker"></span><span class="text"></span>';
    node.querySelector('.speaker').textContent = channel === 'mic' ? '我' : '面试官';
    elements['transcript-list'].appendChild(node);
    block = { node, channel };
    segment.blocks.set(channel, block);
  }
  const blockEntries = segment.entries.filter((candidate) => candidate.channel === channel);
  const blockText = blockEntries.reduce((combined, candidate) => {
    if (!combined) return candidate.text;
    const leftIsCjk = /[\u3400-\u9fff]$/u.test(combined);
    const rightIsCjk = /^[\u3400-\u9fff]/u.test(candidate.text);
    const startsWithPunctuation = /^[\p{P}\p{S}]/u.test(candidate.text);
    const endsWithCjkPunctuation = /[，。！？；：、）】》“”‘’]$/u.test(combined);
    const separator = /\s$/u.test(combined)
      || startsWithPunctuation
      || endsWithCjkPunctuation
      || (leftIsCjk && rightIsCjk)
      ? ''
      : ' ';
    return `${combined}${separator}${candidate.text}`;
  }, '');
  block.node.querySelector('.text').textContent = blockText;
  block.node.classList.toggle('partial', blockEntries.some((candidate) => !candidate.final));
  block.node.title = blockText;
  elements['transcript-list'].scrollTop = elements['transcript-list'].scrollHeight;
  elements['transcript-state'].textContent = event.final ? '已确认' : '识别中';
}

function triggerAnswer() {
  if (!state.meeting || state.answerPending) return;
  api.triggerAnswer().catch((error) => showToast(errorMessage(error), 'error'));
}

function acceleratorFromEvent(event) {
  if (event.key === 'Escape') return null;
  const ignored = new Set(['Control', 'Shift', 'Alt', 'Meta']);
  if (ignored.has(event.key)) return '';
  const modifiers = [];
  if (event.ctrlKey || event.metaKey) modifiers.push('CommandOrControl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (!modifiers.length) throw new Error('快捷键至少需要 Ctrl、Alt 或 Shift');
  let key = event.key.length === 1 ? event.key.toUpperCase() : event.key.replace(/^Arrow/, '');
  if (key === ' ') key = 'Space';
  return [...modifiers, key].join('+');
}

function beginHotkeyRecording() {
  const button = elements['hotkey-recorder'];
  button.classList.add('recording');
  button.textContent = '请按组合键';
  const listener = async (event) => {
    event.preventDefault();
    try {
      const accelerator = acceleratorFromEvent(event);
      if (accelerator === '') return;
      document.removeEventListener('keydown', listener, true);
      button.classList.remove('recording');
      if (accelerator === null) return renderConfig();
      state.config = await api.updateConfig({ answerHotkey: accelerator });
      renderConfig();
      showToast('快捷键已更新');
    } catch (error) {
      document.removeEventListener('keydown', listener, true);
      button.classList.remove('recording');
      renderConfig();
      showToast(errorMessage(error), 'error');
    }
  };
  document.addEventListener('keydown', listener, true);
}

api.onTranscript((event) => state.meeting && renderTranscript(event));
api.onAudioStatus((event) => {
  const channel = event.channel === 'mic' ? 'mic' : 'system';
  state.audioStatus[channel] = event.state;
  if (event.error) state.audioErrors[channel] = event.error;
  else delete state.audioErrors[channel];
  if (!state.meeting) return;
  renderAudioStatus();
});
api.onAnswerStarted(() => {
  if (!state.meeting) return;
  beginTranscriptSegment();
  resetAnswerTokenBuffer();
  state.answerPending = true;
  state.answerCount += 1;
  elements['answer-button'].disabled = true;
  elements['answer-output'].querySelector('.empty-state')?.remove();
  const item = document.createElement('div');
  item.className = 'answer-item generating';
  item.innerHTML = '<div class="answer-index"></div><div class="answer-text"></div>';
  item.querySelector('.answer-index').textContent = `回答 ${String(state.answerCount).padStart(2, '0')}`;
  elements['answer-output'].appendChild(item);
  state.currentAnswerNode = item;
  elements['answer-output'].scrollTop = elements['answer-output'].scrollHeight;
  elements['answer-state'].textContent = '正在生成';
});
api.onAnswerToken(({ token }) => {
  if (!state.meeting || !state.currentAnswerNode) return;
  state.answerTokenBuffer += token;
  scheduleAnswerTokenFlush();
});
api.onAnswerReplace(({ text }) => {
  if (!state.meeting || !state.currentAnswerNode) return;
  resetAnswerTokenBuffer();
  state.currentAnswerNode.querySelector('.answer-text').textContent = text;
});
api.onAnswerDone(() => {
  flushAnswerTokens();
  state.answerPending = false;
  elements['answer-button'].disabled = false;
  state.currentAnswerNode?.classList.remove('generating');
  state.currentAnswerNode = null;
  elements['answer-state'].textContent = '已完成';
});
api.onAnswerError(({ message }) => {
  flushAnswerTokens();
  state.answerPending = false;
  elements['answer-button'].disabled = false;
  state.currentAnswerNode?.classList.remove('generating');
  elements['answer-state'].textContent = '生成失败';
  const text = state.currentAnswerNode?.querySelector('.answer-text');
  if (text && !text.textContent) text.textContent = message;
  state.currentAnswerNode = null;
  showToast(message, 'error');
});

elements['supplement'].addEventListener('input', () => {
  elements['supplement-count'].textContent = `${elements.supplement.value.length} / 30000`;
});
elements['test-server'].addEventListener('click', testServer);
elements['activate-button'].addEventListener('click', activate);
elements['activation-code'].addEventListener('keydown', (event) => { if (event.key === 'Enter') activate(); });
elements['deactivate-button'].addEventListener('click', async () => {
  state.config = await api.deactivate();
  state.connected = false;
  renderConfig();
});
elements['hotkey-recorder'].addEventListener('click', beginHotkeyRecording);
elements['start-button'].addEventListener('click', startMeeting);
elements['stop-button'].addEventListener('click', stopMeeting);
elements['answer-button'].addEventListener('click', triggerAnswer);
elements['minimize-button'].addEventListener('click', () => api.minimize());
elements['hide-button'].addEventListener('click', () => api.hide());
window.addEventListener('beforeunload', stopCaptures);

(async function initialize() {
  refreshIcons();
  state.config = await api.getConfig();
  renderConfig();
  await testServer();
})().catch((error) => showToast(errorMessage(error), 'error'));
