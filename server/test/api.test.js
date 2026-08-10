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
    activationCodes: new Map([['activate-me', 'student-1'], ['activate-other', 'student-2']]), sessionTtlMs: 60_000, maxSupplementChars: 30_000,
    persistenceQueueLimit: 1000, requireStudentProvider: false,
    sttProvider: 'mock', seedAsr: {}, llm: { provider: 'api', codexConfigPath: '', codexAuthPath: '', baseUrl: 'http://invalid', apiKey: '', model: 'mock', reasoningEffort: 'low' },
    xiaomuai: {
      baseUrl: 'https://xiaomuai.cn/v1', llmModel: 'gpt-5.6-terra', sttModel: 'seed-asr', timeoutMs: 100,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }] }), { status: 200 }),
    },
  };
  const application = createApplication(config);
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${application.server.address().port}`;
  return { application, baseUrl, dataDir };
}

async function activate(baseUrl, code = 'activate-me', deviceId = 'device-12345678') {
  const response = await fetch(`${baseUrl}/v1/student/activate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceId }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return { token, headers: { authorization: `Bearer ${token}`, 'x-device-id': deviceId, 'content-type': 'application/json' } };
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

test('failed answer generation does not advance the answered transcript boundary', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  try {
    await application.masterStore.put({ text: '主线程资料，用于回答失败边界测试。'.repeat(4), version: 'v1' });
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

test('student provider configuration is isolated and never returns the API key', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  const apiKey = 'student-one-secret-key';
  try {
    const first = await activate(baseUrl);
    const second = await activate(baseUrl, 'activate-other', 'device-87654321');
    let response = await fetch(`${baseUrl}/v1/student/provider`, {
      method: 'PUT', headers: first.headers,
      body: JSON.stringify({ apiKey, llmModel: 'gpt-5.6-terra', sttModel: 'some-stt-model-ignored' }),
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.deepEqual(saved, {
      configured: true,
      baseUrl: 'https://xiaomuai.cn/v1',
      llmModel: 'gpt-5.6-terra',
      sttModel: 'seed-asr',
      llmAvailable: true,
      sttAvailable: false,
    });
    assert.equal(JSON.stringify(saved).includes(apiKey), false);

    response = await fetch(`${baseUrl}/v1/student/provider`, { headers: first.headers });
    assert.equal((await response.text()).includes(apiKey), false);
    response = await fetch(`${baseUrl}/v1/student/provider`, { headers: second.headers });
    assert.deepEqual(await response.json(), { configured: false });

    response = await fetch(`${baseUrl}/v1/student/provider/models`, { headers: first.headers });
    assert.deepEqual(await response.json(), { models: ['gpt-5.6-terra'] });
    response = await fetch(`${baseUrl}/v1/student/provider/models`, { headers: second.headers });
    assert.equal(response.status, 409);

    response = await fetch(`${baseUrl}/v1/admin/students/student-1`, { headers: { 'x-admin-key': 'admin-secret' } });
    assert.equal((await response.text()).includes(apiKey), false);

    response = await fetch(`${baseUrl}/v1/student/provider`, { method: 'DELETE', headers: first.headers });
    assert.deepEqual(await response.json(), { configured: false });
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('history persists after student end and admin deletion remains student-scoped', async () => {
  const { application, baseUrl, dataDir } = await fixture();
  try {
    await application.masterStore.put({ text: '用于历史记录测试的主线程资料。'.repeat(4), version: 'v1' });
    const first = await activate(baseUrl);
    const second = await activate(baseUrl, 'activate-other', 'device-87654321');

    const createFirst = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: first.headers, body: JSON.stringify({ supplement: '第一位学员补充包' }),
    });
    const firstInfo = await createFirst.json();
    const firstSession = application.sessionStore.get(firstInfo.id, 'student-1');
    application.sessionStore.addTranscript(firstSession, 'system', { utteranceId: 'u-1', text: '请介绍项目', final: true });
    application.sessionStore.addTranscript(firstSession, 'system', { utteranceId: 'u-1', text: '请详细介绍项目', final: true });
    const answer = { question: '请详细介绍项目', answer: '我负责了核心模块。', at: Date.now() };
    firstSession.answerHistory.push(answer);
    await application.historyStore.recordAnswer(firstSession, answer);
    let response = await fetch(`${baseUrl}/v1/sessions/${firstInfo.id}`, { method: 'DELETE', headers: first.headers, body: '{}' });
    assert.equal(response.status, 204);

    const createSecond = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: second.headers, body: JSON.stringify({ supplement: '第二位学员补充包' }),
    });
    const secondInfo = await createSecond.json();
    response = await fetch(`${baseUrl}/v1/sessions/${secondInfo.id}`, { method: 'DELETE', headers: second.headers, body: '{}' });
    assert.equal(response.status, 204);
    await application.sessionStore.waitForMemoryJobs();

    const adminHeaders = { 'x-admin-key': 'admin-secret' };
    response = await fetch(`${baseUrl}/v1/admin/students`);
    assert.equal(response.status, 401);
    response = await fetch(`${baseUrl}/v1/admin/students/missing`, { headers: adminHeaders });
    assert.equal(response.status, 404);

    response = await fetch(`${baseUrl}/v1/admin/students/student-1`, { headers: adminHeaders });
    const firstDetail = await response.json();
    assert.equal(response.status, 200);
    assert.equal(firstDetail.sessions.length, 1);
    assert.equal(firstDetail.sessions[0].supplement, '第一位学员补充包');

    response = await fetch(`${baseUrl}/v1/admin/students/student-1/sessions/${firstInfo.id}`, { headers: adminHeaders });
    const sessionDetail = await response.json();
    assert.equal(sessionDetail.transcripts.length, 1);
    assert.equal(sessionDetail.transcripts[0].text, '请详细介绍项目');
    assert.equal(sessionDetail.answers[0].answer, '我负责了核心模块。');

    response = await fetch(`${baseUrl}/v1/admin/students/student-1/sessions/${firstInfo.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(response.status, 204);
    response = await fetch(`${baseUrl}/v1/admin/students/student-1/sessions/${firstInfo.id}`, { headers: adminHeaders });
    assert.equal(response.status, 404);
    response = await fetch(`${baseUrl}/v1/admin/students/student-2/sessions/${secondInfo.id}`, { headers: adminHeaders });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/v1/admin/students/student-1`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(response.status, 204);
    response = await fetch(`${baseUrl}/v1/admin/students/student-1`, { headers: adminHeaders });
    assert.equal(response.status, 404);
    response = await fetch(`${baseUrl}/v1/admin/students/student-2`, { headers: adminHeaders });
    assert.equal(response.status, 200);
  } finally {
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
