import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApplication } from '../src/app.js';

async function fixture(overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'interview-api-'));
  const config = {
    host: '127.0.0.1', port: 0, publicBaseUrl: '', dataDir,
    masterEncryptionKey: randomBytes(32), adminApiKey: 'admin-secret', studentTokenSecret: 'student-secret',
    activationCodes: new Map([['activate-me', 'student-1']]), sessionTtlMs: 60_000, maxSupplementChars: 30_000,
    sttProvider: 'mock', seedAsr: {}, trustProxy: false, studentTokenTtlMs: 60_000,
    llm: { provider: 'api', codexConfigPath: '', codexAuthPath: '', baseUrl: 'http://invalid', apiKey: '', model: 'mock', reasoningEffort: 'low' },
    ...overrides,
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
      body: JSON.stringify({ studentId: 'student-1', text: masterText, version: '2026.08' }),
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
    await application.masterStore.put({ studentId: 'student-1', text: '足够长的主线程包内容，用于服务端检索和安全测试。', version: 'v1' });
    const unauthorized = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ supplement: 'x' }),
    });
    assert.equal(unauthorized.status, 401);

    const activation = await fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'activate-me', deviceId: 'device-12345678' }),
    });
    const { token } = await activation.json();
    const maxLengthUnicode = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678' },
      body: JSON.stringify({ supplement: '中'.repeat(30_000) }),
    });
    assert.equal(maxLengthUnicode.status, 201);

    const oversized = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678' },
      body: JSON.stringify({ supplement: '中'.repeat(30_001) }),
    });
    assert.equal(oversized.status, 400);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('student sessions use the assigned master pack and reject unassigned students', async () => {
  const { application, baseUrl, dataDir } = await fixture({
    activationCodes: new Map([
      ['activate-a', 'student-a'],
      ['activate-b', 'student-b'],
    ]),
  });
  try {
    let response = await fetch(`${baseUrl}/v1/admin/master-pack`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-secret' },
      body: JSON.stringify({ text: '没有学员 ID 的包不应该被接受。' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'student_id_required');

    const activate = (code, deviceId) => fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceId }),
    });
    const first = await activate('activate-a', 'device-a-12345678');
    const second = await activate('activate-b', 'device-b-12345678');
    const firstToken = (await first.json()).token;
    const secondToken = (await second.json()).token;
    const headers = (token, deviceId) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': deviceId });

    response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: headers(secondToken, 'device-b-12345678'), body: JSON.stringify({ supplement: '' }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'master_pack_not_configured');

    await application.masterStore.put({ studentId: 'student-a', text: '学员 A 的独立主线程包，长度足够用于测试。', version: 'a-v1' });
    response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: headers(firstToken, 'device-a-12345678'), body: JSON.stringify({ supplement: '' }),
    });
    assert.equal(response.status, 201);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('activation binds the code while authenticated requests tolerate public IP changes', async () => {
  const { application, baseUrl, dataDir } = await fixture({ trustProxy: true });
  try {
    const activate = (deviceId, ip) => fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify({ code: 'activate-me', deviceId }),
    });
    const first = await activate('device-12345678', '203.0.113.10');
    assert.equal(first.status, 200);
    const { token } = await first.json();
    assert.equal((await activate('device-87654321', '203.0.113.10')).status, 409);
    assert.equal((await activate('device-12345678', '203.0.113.11')).status, 200);

    await application.masterStore.put({ studentId: 'student-1', text: '用于公网 IP 漂移鉴权测试的独立主线程包内容。', version: 'v1' });
    const session = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: `Bearer ${token}`,
        'x-device-id': 'device-12345678', 'x-real-ip': '203.0.113.11',
      },
      body: JSON.stringify({ supplement: '' }),
    });
    assert.equal(session.status, 201);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('admin can revoke and reset a binding', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  try {
    const activation = await fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'activate-me', deviceId: 'device-12345678' }),
    });
    const { token } = await activation.json();
    let response = await fetch(`${baseUrl}/v1/admin/student-bindings`, { headers: { 'x-admin-key': 'admin-secret' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bindings[0].studentId, 'student-1');
    response = await fetch(`${baseUrl}/v1/admin/student-bindings/student-1`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-secret' }, body: JSON.stringify({ action: 'revoke' }),
    });
    assert.equal(response.status, 204);
    response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678' }, body: JSON.stringify({ supplement: '' }),
    });
    assert.equal(response.status, 401);
    response = await fetch(`${baseUrl}/v1/admin/student-bindings/student-1`, { method: 'DELETE', headers: { 'x-admin-key': 'admin-secret' } });
    assert.equal(response.status, 204);
    response = await fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'activate-me', deviceId: 'device-87654321' }),
    });
    assert.equal(response.status, 200);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('failed answer generation does not advance the answered transcript boundary', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  try {
    await application.masterStore.put({ studentId: 'student-1', text: '主线程资料，用于回答失败边界测试。'.repeat(4), version: 'v1' });
    const activation = await fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'activate-me', deviceId: 'device-12345678' }),
    });
    const { token } = await activation.json();
    const headers = { authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678', 'content-type': 'application/json' };
    const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers, body: JSON.stringify({ supplement: '' }),
    });
    const sessionInfo = await sessionResponse.json();
    const session = application.sessionStore.get(sessionInfo.id, 'student-1');
    application.sessionStore.addTranscript(session, 'system', { utteranceId: 'question-1', text: '请介绍项目', final: true });

    const answerResponse = await fetch(`${baseUrl}/v1/sessions/${sessionInfo.id}/answer`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(answerResponse.status, 200);
    assert.match(await answerResponse.text(), /answer_generation_failed/);
    assert.match(application.sessionStore.context(session).text, /请介绍项目/);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a concurrent answer request is rejected while new transcript remains queued', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  try {
    await application.masterStore.put({ studentId: 'student-1', text: '用于并发回答边界测试的主线程资料。'.repeat(4), version: 'v1' });
    const activation = await fetch(`${baseUrl}/v1/student/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'activate-me', deviceId: 'device-12345678' }),
    });
    const { token } = await activation.json();
    const headers = { authorization: `Bearer ${token}`, 'x-device-id': 'device-12345678', 'content-type': 'application/json' };
    const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers, body: JSON.stringify({ supplement: '' }),
    });
    const sessionInfo = await sessionResponse.json();
    const session = application.sessionStore.get(sessionInfo.id, 'student-1');
    application.sessionStore.addTranscript(session, 'system', { utteranceId: 'question-1', text: '正在回答的问题', final: true });
    const snapshot = application.sessionStore.answerContext(session);
    let releaseMaster;
    let markMasterReadStarted;
    const masterReadStarted = new Promise((resolve) => { markMasterReadStarted = resolve; });
    const masterGate = new Promise((resolve) => { releaseMaster = resolve; });
    application.masterStore.get = async () => {
      markMasterReadStarted();
      await masterGate;
      return { text: '用于并发回答边界测试的主线程资料。'.repeat(4), version: 'v1' };
    };
    const firstResponsePromise = fetch(`${baseUrl}/v1/sessions/${sessionInfo.id}/answer`, {
      method: 'POST', headers, body: '{}',
    });
    await masterReadStarted;
    application.sessionStore.addTranscript(session, 'system', { utteranceId: 'question-2', text: '重试期间到达的新问题', final: true });

    const concurrentResponse = await fetch(`${baseUrl}/v1/sessions/${sessionInfo.id}/answer`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(concurrentResponse.status, 409);
    assert.equal((await concurrentResponse.json()).error, 'answer_in_progress');
    assert.equal(application.sessionStore.answerContext(session).text, snapshot.text);
    assert.match(application.sessionStore.context(session).text, /重试期间到达的新问题/);
    releaseMaster();
    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.status, 200);
    assert.match(await firstResponse.text(), /answer_generation_failed/);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
