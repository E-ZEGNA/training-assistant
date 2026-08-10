import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SeedAsrStream } from './seed-asr.js';

function providerError(status, body) {
  // Do not reflect provider response text: upstream gateways occasionally
  // include request metadata or credentials in diagnostic messages.
  const error = new Error(`XiaomuAI request failed (${status})`);
  error.statusCode = status;
  error.code = body?.error?.code ?? 'xiaomuai_request_failed';
  return error;
}

function providerAbort(error) {
  if (error?.name !== 'AbortError') return error;
  const timeout = new Error('XiaomuAI request timed out');
  timeout.statusCode = 504;
  timeout.code = 'xiaomuai_timeout';
  return timeout;
}

export async function inspectXiaomuaiProvider({ baseUrl, apiKey, llmModel, sttModel, timeoutMs = 5000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(response.status, body);
    const models = new Set((Array.isArray(body.data) ? body.data : []).map((item) => item?.id).filter(Boolean));
    return {
      configured: true,
      baseUrl: baseUrl.replace(/\/$/, ''),
      apiKey,
      llmModel,
      sttModel,
      llmAvailable: models.has(llmModel),
      sttAvailable: models.has(sttModel),
    };
  } catch (error) {
    throw providerAbort(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function listXiaomuaiModels({ baseUrl, apiKey, timeoutMs = 5000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(response.status, body);
    return (Array.isArray(body.data) ? body.data : []).map((item) => item?.id).filter(Boolean).sort();
  } catch (error) {
    throw providerAbort(error);
  } finally {
    clearTimeout(timer);
  }
}

function pcmToWav(pcm, sampleRate = 16000) {
  const output = Buffer.allocUnsafe(44 + pcm.length);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + pcm.length, 4);
  output.write('WAVEfmt ', 8, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(pcm.length, 40);
  pcm.copy(output, 44);
  return output;
}

export class XiaomuaiAsrStream extends EventEmitter {
  constructor({ baseUrl, apiKey, model, timeoutMs = 5000, fetchImpl = fetch, chunkBytes = 64_000 }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.chunkBytes = chunkBytes;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.processing = false;
    this.sequence = 0;
  }

  start() { this.emit('status', { state: 'connected', provider: 'xiaomuai' }); }

  sendAudio(audio) {
    if (this.closed || !audio?.length) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(audio)]);
    if (this.buffer.length > 320_000) this.buffer = this.buffer.subarray(this.buffer.length - 320_000);
    this.drain();
  }

  async drain() {
    if (this.processing || this.closed || this.buffer.length < this.chunkBytes) return;
    this.processing = true;
    const pcm = this.buffer.subarray(0, this.chunkBytes);
    this.buffer = this.buffer.subarray(this.chunkBytes);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const wav = pcmToWav(pcm);
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav.toString('base64')}` } }] }],
          asr_options: { language: 'auto' },
          stream: false,
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw providerError(response.status, body);
      this.emit('audio-consumed', pcm.length);
      const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
      if (text) this.emit('transcript', { text, final: true, utteranceId: `xiaomuai:${++this.sequence}` });
    } catch (error) {
      this.emit('error', providerAbort(error));
    } finally {
      clearTimeout(timer);
      this.processing = false;
      if (!this.closed) this.drain();
    }
  }

  stop() { this.closed = true; this.buffer = Buffer.alloc(0); }
}

export class FallbackAsrStream extends EventEmitter {
  constructor({ primary, createFallback }) {
    super();
    this.primary = primary;
    this.active = primary;
    this.createFallback = createFallback;
    this.audioBuffer = [];
    this.audioBytes = 0;
    this.closed = false;
    this.fallbackStarted = false;
    this.bind(primary, 'xiaomuai');
  }

  bind(stream, provider) {
    stream.on('transcript', (event) => this.emit('transcript', { ...event, provider }));
    stream.on('status', (status) => this.emit('status', { ...status, provider }));
    if (provider === 'xiaomuai') stream.on('audio-consumed', (bytes) => this.consumeAudio(bytes));
    stream.on('close', () => provider === 'xiaomuai' ? this.fallback(new Error('XiaomuAI STT stream closed')) : this.emit('close'));
    stream.on('error', (error) => provider === 'xiaomuai' ? this.fallback(error) : this.emit('error', error));
  }

  consumeAudio(bytes) {
    let remaining = Math.max(0, Number(bytes) || 0);
    while (remaining > 0 && this.audioBuffer.length) {
      const first = this.audioBuffer[0];
      if (first.length <= remaining) {
        this.audioBuffer.shift();
        this.audioBytes -= first.length;
        remaining -= first.length;
      } else {
        this.audioBuffer[0] = first.subarray(remaining);
        this.audioBytes -= remaining;
        remaining = 0;
      }
    }
  }

  start() { this.active.start(); }

  sendAudio(audio) {
    if (this.closed || !audio?.length) return;
    if (!this.fallbackStarted) {
      const copy = Buffer.from(audio);
      this.audioBuffer.push(copy);
      this.audioBytes += copy.length;
      while (this.audioBytes > 160_000 && this.audioBuffer.length > 1) this.audioBytes -= this.audioBuffer.shift().length;
    }
    this.active.sendAudio(audio);
  }

  fallback(reason) {
    if (this.fallbackStarted || this.closed) return;
    this.fallbackStarted = true;
    this.primary.stop();
    const fallback = this.createFallback();
    this.active = fallback;
    this.bind(fallback, 'seed-asr');
    this.emit('status', { state: 'fallback', provider: 'seed-asr', reason: reason?.code ?? 'xiaomuai_unavailable' });
    fallback.start();
    for (const audio of this.audioBuffer.splice(0)) fallback.sendAudio(audio);
    this.audioBytes = 0;
  }

  stop() { this.closed = true; this.audioBuffer = []; this.active.stop(); }
}

export function createStudentAsrStream({ provider, seedConfig, uid, hotwords }) {
  const createSeed = () => new SeedAsrStream({ ...seedConfig, uid, hotwords });
  if (!provider?.configured || !provider.sttAvailable) return createSeed();
  const primary = new XiaomuaiAsrStream({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.sttModel,
    timeoutMs: provider.timeoutMs,
  });
  return new FallbackAsrStream({ primary, createFallback: createSeed });
}
