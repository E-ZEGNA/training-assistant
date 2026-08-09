import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../src/app.js';

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'interview-api-'));
  const config = {
    host: '127.0.0.1', port: 0, publicBaseUrl: '', dataDir,
    masterEncryptionKey: randomBytes(32), adminApiKey: 'admin-secret', studentTokenSecret: 'student-secret',
    activationCodes: new Map([['activate-me', 'student-1']]), sessionTtlMs: 60_000, maxSupplementChars: 30_000,
    sttProvider: 'mock', seedAsr: {}, llm: { provider: 'api', codexConfigPath: '', codexAuthPath: '', baseUrl: 'http://invalid', apiKey: '', model: 'mock', reasoningEffort: 'low' },
  };
  const application = createApplication(config);
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${application.server.address().port}`;
  return { application, baseUrl, dataDir };
}

test('admin publishes without exposing master content to student endpoints', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  try {
    const masterText = '机密主包：GPU 调度项目，利用率提升 18%，故障恢复时间降低 40%。';
    let response = await fetch(`${baseUrl}/v1/admin/master-pack`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-secret' },
      body: JSON.stringify({ text: masterText, version: '2026.08' }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'activate-me', deviceId: 'device-12345678' }),
    });
    const { token } = await response.json();
    assert.ok(token);

    response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678' },
      body: JSON.stringify({ supplement: '本场目标岗位是 ML Infra' }),
    });
    const session = await response.json();
    assert.equal(response.status, 201);
    assert.ok(session.id);
    assert.equal(JSON.stringify(session).includes(masterText), false);

    response = await fetch(`${baseUrl}/v1/admin/master-pack`);
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes(masterText), false);

    response = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 204);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('student routes enforce authorization and supplement limits', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  try {
    await application.masterStore.put({ text: '足够长的主线程包内容，用于服务端检索和安全测试。', version: 'v1' });
    const unauthorized = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ supplement: 'x' }),
    });
    assert.equal(unauthorized.status, 401);

    const activation = await fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'activate-me', deviceId: 'device-12345678' }),
    });
    const { token } = await activation.json();
    const oversized = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678' },
      body: JSON.stringify({ supplement: 'x'.repeat(30_001) }),
    });
    assert.equal(oversized.status, 400);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
