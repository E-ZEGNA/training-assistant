import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { FallbackAsrStream, inspectXiaomuaiProvider, listXiaomuaiModels, XiaomuaiAsrStream } from '../src/xiaomuai.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('provider inspection reports model availability and model list is sorted', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    data: [{ id: 'mimo-v2.5-asr' }, { id: 'gpt-5.6-terra' }, { id: 'alpha' }],
  });
  const provider = await inspectXiaomuaiProvider({
    baseUrl: 'https://xiaomuai.cn/v1/', apiKey: 'secret-key',
    llmModel: 'gpt-5.6-terra', sttModel: 'missing-stt', fetchImpl,
  });
  assert.equal(provider.baseUrl, 'https://xiaomuai.cn/v1');
  assert.equal(provider.llmAvailable, true);
  assert.equal(provider.sttAvailable, false);
  assert.deepEqual(await listXiaomuaiModels({
    baseUrl: provider.baseUrl, apiKey: provider.apiKey, fetchImpl,
  }), ['alpha', 'gpt-5.6-terra', 'mimo-v2.5-asr']);
});

test('provider errors do not reflect upstream text or API keys', async () => {
  const apiKey = 'secret-key-that-must-not-leak';
  const fetchImpl = async () => jsonResponse(503, {
    error: { code: 'model_not_found', message: `diagnostic includes ${apiKey}` },
  });
  await assert.rejects(
    inspectXiaomuaiProvider({
      baseUrl: 'https://xiaomuai.cn/v1', apiKey,
      llmModel: 'gpt-5.6-terra', sttModel: 'mimo-v2.5-asr', fetchImpl,
    }),
    (error) => error.code === 'model_not_found'
      && error.statusCode === 503
      && !error.message.includes(apiKey)
      && !error.message.includes('diagnostic'),
  );
});

test('provider timeout is classified without hanging', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(
    listXiaomuaiModels({ baseUrl: 'https://xiaomuai.cn/v1', apiKey: 'secret-key', timeoutMs: 5, fetchImpl }),
    (error) => error.code === 'xiaomuai_timeout' && error.statusCode === 504,
  );
});

test('XiaomuAI audio adapter sends WAV input and emits one final transcript', async () => {
  let requestBody;
  const stream = new XiaomuaiAsrStream({
    baseUrl: 'https://xiaomuai.cn/v1', apiKey: 'secret-key', model: 'mimo-v2.5-asr',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse(200, { choices: [{ message: { content: '测试转写' } }] });
    },
  });
  stream.start();
  const transcriptPromise = once(stream, 'transcript');
  stream.sendAudio(Buffer.alloc(64_000, 1));
  const [event] = await transcriptPromise;
  assert.equal(event.text, '测试转写');
  assert.equal(event.final, true);
  assert.equal(requestBody.model, 'mimo-v2.5-asr');
  assert.match(requestBody.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
  stream.stop();
});

class FakeAsr extends EventEmitter {
  constructor() {
    super();
    this.audio = [];
    this.started = 0;
    this.stopped = 0;
  }
  start() { this.started += 1; }
  sendAudio(audio) { this.audio.push(Buffer.from(audio)); }
  stop() { this.stopped += 1; }
}

test('fallback starts once and replays only unacknowledged audio in order', () => {
  const primary = new FakeAsr();
  const seed = new FakeAsr();
  let creations = 0;
  const stream = new FallbackAsrStream({ primary, createFallback: () => { creations += 1; return seed; } });
  stream.start();
  stream.sendAudio(Buffer.from('first'));
  stream.sendAudio(Buffer.from('second'));
  primary.emit('audio-consumed', 5);
  primary.emit('error', Object.assign(new Error('upstream failed'), { code: 'model_not_found' }));
  primary.emit('error', new Error('duplicate error'));
  stream.sendAudio(Buffer.from('third'));

  assert.equal(creations, 1);
  assert.equal(primary.stopped, 1);
  assert.equal(seed.started, 1);
  assert.deepEqual(seed.audio.map((item) => item.toString()), ['second', 'third']);
  stream.stop();
});
