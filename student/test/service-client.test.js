const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ServiceClient, ServiceError } = require('../electron/service-client');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function clientFor(baseUrl) {
  const client = new ServiceClient({
    value: { serverUrl: baseUrl, activationToken: 'test-token', deviceId: 'test-device-1234' },
  });
  client.sessionId = 'session-1';
  return client;
}

function inactiveClientFor(baseUrl) {
  return new ServiceClient({
    value: { serverUrl: baseUrl, activationToken: 'test-token', deviceId: 'test-device-1234' },
  });
}

test('model options are fetched with student credentials and selected model starts the session', async () => {
  const requests = [];
  await withServer(async (req, res) => {
    requests.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      deviceId: req.headers['x-device-id'],
      body: await new Promise((resolve) => {
        let value = '';
        req.on('data', (chunk) => { value += chunk; });
        req.on('end', () => resolve(value));
      }),
    });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/student/options') {
      res.end(JSON.stringify({
        models: [{ id: 'gpt-5.6-sol', label: '质量优先' }, { id: 'gpt-5.6-terra', label: '均衡' }],
        defaultModel: 'gpt-5.6-sol',
        reasoningEfforts: [{ id: 'low', label: '轻量' }, { id: 'high', label: '深度' }],
        defaultReasoningEffort: 'low',
      }));
      return;
    }
    res.statusCode = 201;
    res.end(JSON.stringify({ id: 'selected-session', model: 'gpt-5.6-terra' }));
  }, async (baseUrl) => {
    const client = inactiveClientFor(baseUrl);
    client.openAudioSocket = () => {};
    const options = await client.options();
    assert.equal(options.defaultModel, 'gpt-5.6-sol');
    assert.equal(options.defaultReasoningEffort, 'low');
    await client.startSession('本场补充', 'gpt-5.6-terra', 'high');
    assert.equal(client.sessionId, 'selected-session');
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/v1/student/options');
  assert.equal(requests[0].authorization, 'Bearer test-token');
  assert.equal(requests[0].deviceId, 'test-device-1234');
  assert.deepEqual(JSON.parse(requests[1].body), {
    supplement: '本场补充', model: 'gpt-5.6-terra', reasoningEffort: 'high',
  });
});

test('invalid model option payload is rejected', async () => {
  await withServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [], defaultModel: 123 }));
  }, async (baseUrl) => {
    const client = inactiveClientFor(baseUrl);
    await assert.rejects(client.options(), (error) => error instanceof ServiceError && error.code === 'invalid_interview_options');
  });
});

test('answer consumes token and replacement events until done', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: token\ndata: {"token":"临时内容"}\n\n');
    res.write('event: replace\ndata: {"text":"安全回答"}\n\n');
    res.end('event: done\ndata: {"ok":true}\n\n');
  }, async (baseUrl) => {
    const client = clientFor(baseUrl);
    const replacements = [];
    client.on('answer-replace', (event) => replacements.push(event.text));
    assert.equal(await client.answer(), '安全回答');
    assert.deepEqual(replacements, ['安全回答']);
  });
});

test('answer forwards retry progress without starting a second request', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: retry\ndata: {"attempt":2,"maxAttempts":3}\n\n');
    res.write('event: token\ndata: {"token":"重试成功"}\n\n');
    res.end('event: done\ndata: {"ok":true}\n\n');
  }, async (baseUrl) => {
    const client = clientFor(baseUrl);
    const retries = [];
    client.on('answer-retry', (event) => retries.push(event));
    assert.equal(await client.answer(), '重试成功');
    assert.equal(requests, 1);
    assert.deepEqual(retries, [{ attempt: 2, maxAttempts: 3 }]);
  });
});

test('answer rejects a stream that closes without done', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: token\ndata: {"token":"不完整"}\n\n');
  }, async (baseUrl) => {
    const client = clientFor(baseUrl);
    await assert.rejects(client.answer(), (error) => error instanceof ServiceError && error.code === 'answer_stream_interrupted');
  });
});

test('a 401 response emits an authorization failure for client recovery', async () => {
  await withServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  }, async (baseUrl) => {
    const client = clientFor(baseUrl);
    const failures = [];
    client.on('authorization-failed', (error) => failures.push(error.code));
    await assert.rejects(client.request('/protected'), (error) => error instanceof ServiceError && error.code === 'unauthorized');
    assert.deepEqual(failures, ['unauthorized']);
  });
});
