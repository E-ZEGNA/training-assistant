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
