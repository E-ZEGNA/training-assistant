import { EventEmitter } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const MESSAGE = {
  FULL_CLIENT: 0x1,
  AUDIO_ONLY: 0x2,
  FULL_SERVER: 0x9,
  ERROR: 0xf,
};

export function encodeFrame({ type, flags = 0, serialization = 0, compression = 1, payload = Buffer.alloc(0) }) {
  const body = compression === 1 ? gzipSync(payload) : payload;
  const header = Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | compression, 0x00]);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, size, body]);
}

export function decodeFrame(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 8) throw new Error('Seed-ASR frame is shorter than the minimum header');
  const headerBytes = (buffer[0] & 0x0f) * 4;
  const type = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerBytes;
  let sequence;
  let errorCode;
  if (type === MESSAGE.FULL_SERVER && (flags & 0x1)) {
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  } else if (type === MESSAGE.ERROR) {
    errorCode = buffer.readUInt32BE(offset);
    offset += 4;
  }
  if (buffer.length < offset + 4) throw new Error('Seed-ASR frame is missing payload length');
  const size = buffer.readUInt32BE(offset);
  offset += 4;
  if (buffer.length < offset + size) throw new Error('Seed-ASR frame payload is truncated');
  let payload = buffer.subarray(offset, offset + size);
  if (compression === 1 && payload.length) payload = gunzipSync(payload);
  let data = payload;
  if (serialization === 1 && payload.length) data = JSON.parse(payload.toString('utf8'));
  return { type, flags, serialization, compression, sequence, errorCode, data };
}

export function buildStartRequest({ uid, hotwords = [] }) {
  return {
    user: { uid },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      enable_nonstream: true,
      show_utterances: true,
      result_type: 'full',
      end_window_size: 600,
      force_to_speech_time: 800,
      corpus: hotwords.length
        ? { context: JSON.stringify({ hotwords: hotwords.slice(0, 60) }) }
        : undefined,
    },
  };
}

export class SeedAsrStream extends EventEmitter {
  constructor({ endpoint, apiKey, resourceId, uid, hotwords, WebSocketImpl = WebSocket }) {
    super();
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.resourceId = resourceId;
    this.uid = uid;
    this.hotwords = hotwords;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.queue = [];
    this.closed = false;
    this.lastText = '';
    this.lastFinal = false;
    this.lastUtteranceStart = null;
  }

  start() {
    if (this.ws || this.closed) return;
    const requestId = randomUUID();
    this.ws = new this.WebSocketImpl(this.endpoint, {
      headers: {
        'X-Api-Key': this.apiKey,
        'X-Api-Resource-Id': this.resourceId,
        'X-Api-Request-Id': requestId,
        'X-Api-Connect-Id': randomUUID(),
      },
      handshakeTimeout: 10_000,
    });
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('open', () => {
      const request = Buffer.from(JSON.stringify(buildStartRequest({ uid: this.uid, hotwords: this.hotwords })), 'utf8');
      this.ws.send(encodeFrame({ type: MESSAGE.FULL_CLIENT, serialization: 1, payload: request }));
      for (const audio of this.queue.splice(0)) this.sendAudio(audio);
      this.emit('status', { state: 'connected' });
    });
    this.ws.on('message', (raw) => this.handleMessage(raw));
    this.ws.on('error', (error) => this.emit('error', error));
    this.ws.on('close', (code) => {
      this.ws = null;
      if (!this.closed) this.emit('close', code);
    });
  }

  sendAudio(audio) {
    if (this.closed || !audio?.length) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(Buffer.from(audio));
      let total = this.queue.reduce((sum, item) => sum + item.length, 0);
      while (total > 320_000 && this.queue.length > 1) total -= this.queue.shift().length;
      return;
    }
    this.ws.send(encodeFrame({ type: MESSAGE.AUDIO_ONLY, payload: Buffer.from(audio) }));
  }

  handleMessage(raw) {
    try {
      const frame = decodeFrame(raw);
      if (frame.type === MESSAGE.ERROR) {
        const message = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
        this.emit('error', new Error(`Seed-ASR ${frame.errorCode}: ${message}`));
        return;
      }
      if (frame.type !== MESSAGE.FULL_SERVER || !frame.data?.result) return;
      const result = frame.data.result;
      const utterances = Array.isArray(result.utterances) ? result.utterances : [];
      const latestUtterance = utterances.at(-1);
      const text = String(latestUtterance?.text ?? result.text ?? '').trim();
      const final = latestUtterance?.definite === true;
      const utteranceStart = Number.isFinite(latestUtterance?.start_time) ? latestUtterance.start_time : null;
      if (text && (text !== this.lastText || final !== this.lastFinal || utteranceStart !== this.lastUtteranceStart)) {
        this.lastText = text;
        this.lastFinal = final;
        this.lastUtteranceStart = utteranceStart;
        this.emit('transcript', { text, final, utterances: latestUtterance ? [latestUtterance] : [] });
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  stop() {
    this.closed = true;
    this.queue = [];
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeFrame({ type: MESSAGE.AUDIO_ONLY, flags: 0x2, payload: Buffer.alloc(0) }));
      setTimeout(() => this.ws?.close(1000), 250).unref?.();
    } else {
      this.ws?.terminate?.();
    }
    this.ws = null;
  }
}

export class MockAsrStream extends EventEmitter {
  constructor() {
    super();
    this.bytesReceived = 0;
    this.emitted = false;
  }
  start() { this.emit('status', { state: 'connected' }); }
  sendAudio(audio) {
    this.bytesReceived += audio?.length ?? 0;
    if (!this.emitted && this.bytesReceived >= 19_200) {
      this.emitted = true;
      this.emit('transcript', { text: '本地模拟转写：已收到音频。', final: true });
    }
  }
  stop() {}
}
