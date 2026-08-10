const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

class ServiceError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class ServiceClient extends EventEmitter {
  constructor(configStore) {
    super();
    this.configStore = configStore;
    this.sessionId = null;
    this.sockets = new Map();
    this.buffers = new Map();
    this.reconnectAttempts = new Map();
    this.reconnectTimers = new Map();
    this.stopped = true;
    this.answerController = null;
  }

  get baseUrl() { return this.configStore.value.serverUrl; }
  get token() { return this.configStore.value.activationToken; }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        'x-device-id': this.configStore.value.deviceId,
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ServiceError(body.error ?? `请求失败 (${response.status})`, response.status, body.error);
    }
    return response;
  }

  async health() {
    const response = await this.request('/health');
    return response.json();
  }

  async activate(code, deviceId) {
    const response = await this.request('/v1/student/activate', {
      method: 'POST',
      body: JSON.stringify({ code, deviceId }),
    });
    return response.json();
  }

  async getProvider() {
    const response = await this.request('/v1/student/provider');
    return response.json();
  }

  async setProvider(configuration) {
    const response = await this.request('/v1/student/provider', { method: 'PUT', body: JSON.stringify(configuration) });
    return response.json();
  }

  async clearProvider() {
    const response = await this.request('/v1/student/provider', { method: 'DELETE' });
    return response.json();
  }

  async getProviderModels() {
    const response = await this.request('/v1/student/provider/models');
    return response.json();
  }

  async startSession(supplement) {
    await this.stopSession();
    const response = await this.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ supplement }),
    });
    const body = await response.json();
    this.sessionId = body.id;
    this.stopped = false;
    this.openAudioSocket('system');
    return body;
  }

  openAudioSocket(channel) {
    if (!this.sessionId || this.stopped) return;
    const websocketUrl = new URL(`/v1/sessions/${encodeURIComponent(this.sessionId)}/audio`, this.baseUrl);
    websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    websocketUrl.searchParams.set('channel', channel);
    const ws = new WebSocket(websocketUrl, {
      headers: { authorization: `Bearer ${this.token}`, 'x-device-id': this.configStore.value.deviceId },
      handshakeTimeout: 10_000,
    });
    this.sockets.set(channel, ws);
    ws.on('open', () => {
      this.reconnectAttempts.set(channel, 0);
      this.emit('status', { channel, state: 'connected' });
      for (const chunk of this.takeBuffered(channel)) ws.send(chunk);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const event = JSON.parse(data.toString('utf8'));
        if (event.type === 'transcript') this.emit('transcript', event);
        if (event.type === 'status') this.emit('status', { channel, ...event });
      } catch {
        this.emit('status', { channel, state: 'failed', error: '服务返回了无效消息' });
      }
    });
    ws.on('error', () => this.emit('status', { channel, state: 'reconnecting' }));
    ws.on('close', () => {
      if (this.sockets.get(channel) === ws) this.sockets.delete(channel);
      if (!this.stopped) this.scheduleReconnect(channel);
    });
  }

  scheduleReconnect(channel) {
    if (this.reconnectTimers.has(channel) || this.stopped) return;
    const attempt = (this.reconnectAttempts.get(channel) ?? 0) + 1;
    this.reconnectAttempts.set(channel, attempt);
    const delay = Math.min(30_000, 750 * 2 ** Math.min(attempt - 1, 6)) + Math.floor(Math.random() * 300);
    this.emit('status', { channel, state: 'reconnecting', attempt });
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(channel);
      this.openAudioSocket(channel);
    }, delay);
    this.reconnectTimers.set(channel, timer);
  }

  sendAudio(channel, bytes) {
    if (this.stopped || !this.sessionId || !bytes?.byteLength) return;
    const chunk = Buffer.from(bytes);
    const ws = this.sockets.get(channel);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(chunk);
      return;
    }
    const queue = this.buffers.get(channel) ?? [];
    queue.push(chunk);
    let size = queue.reduce((sum, item) => sum + item.length, 0);
    while (size > 320_000 && queue.length > 1) size -= queue.shift().length;
    this.buffers.set(channel, queue);
  }

  takeBuffered(channel) {
    const queue = this.buffers.get(channel) ?? [];
    this.buffers.delete(channel);
    return queue;
  }

  async answer() {
    if (!this.sessionId) throw new ServiceError('当前没有进行中的面试', 409, 'no_session');
    this.answerController?.abort();
    const controller = new AbortController();
    this.answerController = controller;
    const response = await this.request(`/v1/sessions/${encodeURIComponent(this.sessionId)}/answer`, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let completed = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const type = event.match(/^event:\s*(.+)$/m)?.[1];
        const raw = event.match(/^data:\s*(.+)$/m)?.[1];
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (type === 'token' && typeof data.token === 'string') {
          answer += data.token;
          this.emit('answer-token', { token: data.token });
        }
        if (type === 'replace' && typeof data.text === 'string') {
          answer = data.text;
          this.emit('answer-replace', { text: data.text });
        }
        if (type === 'done') completed = true;
        if (type === 'error') {
          throw new ServiceError('回答生成失败', 502, data.error ?? 'answer_generation_failed');
        }
      }
    }
    if (!completed) throw new ServiceError('回答流意外中断', 502, 'answer_stream_interrupted');
    this.emit('answer-done', { answer });
    return answer;
  }

  enableMicrophone() {
    if (!this.sockets.has('mic')) this.openAudioSocket('mic');
  }

  async stopSession() {
    this.stopped = true;
    this.answerController?.abort();
    this.answerController = null;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const ws of this.sockets.values()) ws.close(1000);
    this.sockets.clear();
    this.buffers.clear();
    const id = this.sessionId;
    this.sessionId = null;
    if (id && this.token) {
      await this.request(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' }).catch(() => {});
    }
  }
}

module.exports = { ServiceClient, ServiceError };
