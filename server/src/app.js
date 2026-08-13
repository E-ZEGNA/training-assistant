import http from 'node:http';
import { WebSocketServer } from 'ws';
import { bearerToken, issueStudentToken, requireAdmin, verifyStudentDevice, verifyStudentToken } from './auth.js';
import { StudentBindingStore } from './binding-store.js';
import { getClientIp } from './client-ip.js';
import { MasterPackStore } from './crypto-store.js';
import { generateInterviewAnswer, llmErrorDetails } from './llm.js';
import { json, noContent, RateLimiter, readJson, route } from './http-utils.js';
import { SessionStore } from './sessions.js';

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}

function authStudent(req, config, bindingStore) {
  const claims = verifyStudentToken(bearerToken(req), config.studentTokenSecret);
  const deviceId = req.headers['x-device-id'];
  if (!verifyStudentDevice(claims, deviceId)) return null;
  const authorized = bindingStore.verify({
    studentId: claims.sub,
    bindingId: claims.binding,
    deviceId,
  });
  return authorized ? claims : null;
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  res.flushHeaders?.();
}

function sendSse(res, event, data) {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createApplication(config) {
  const masterStore = new MasterPackStore(config.dataDir, config.masterEncryptionKey);
  const bindingStore = new StudentBindingStore(config.dataDir, config.studentTokenSecret);
  const sessionStore = new SessionStore(config, masterStore);
  const activationLimiter = new RateLimiter({ limit: 8, windowMs: 15 * 60_000 });
  const sessionLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });
  const answerLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const { pathname } = requestUrl;
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (req.method === 'GET' && pathname === '/health') {
        return json(res, 200, { ok: true, masterPackConfigured: await masterStore.hasAny() });
      }

      if (req.method === 'GET' && pathname === '/v1/admin/master-pack/status') {
        if (!requireAdmin(req, config)) return json(res, 401, { error: 'unauthorized' });
        const studentId = requestUrl.searchParams.get('studentId') ?? undefined;
        if (studentId) return json(res, 200, await masterStore.status(studentId));
        return json(res, 200, { configured: await masterStore.hasAny() });
      }

      if (req.method === 'PUT' && pathname === '/v1/admin/master-pack') {
        if (!requireAdmin(req, config)) return json(res, 401, { error: 'unauthorized' });
        const body = await readJson(req, 2_100_000);
        const studentId = String(body.studentId ?? '').trim();
        if (!studentId) return json(res, 400, { error: 'student_id_required' });
        const version = String(body.version ?? new Date().toISOString());
        const result = await masterStore.put({ studentId, text: body.text, version });
        log('master_pack_published', { studentId, version: result.version, characters: result.characters });
        return json(res, 200, result);
      }

      if (req.method === 'GET' && pathname === '/v1/admin/student-bindings') {
        if (!requireAdmin(req, config)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, { bindings: bindingStore.list() });
      }

      const bindingParams = route(pathname, '/v1/admin/student-bindings/:studentId');
      if (bindingParams && req.method === 'POST') {
        if (!requireAdmin(req, config)) return json(res, 401, { error: 'unauthorized' });
        const body = await readJson(req, 1024);
        if (body.action !== 'revoke') return json(res, 400, { error: 'invalid_binding_action' });
        if (!bindingStore.revoke(bindingParams.studentId)) return json(res, 404, { error: 'binding_not_found' });
        log('student_binding_revoked', { studentId: bindingParams.studentId });
        return noContent(res);
      }

      if (bindingParams && req.method === 'DELETE') {
        if (!requireAdmin(req, config)) return json(res, 401, { error: 'unauthorized' });
        if (!bindingStore.reset(bindingParams.studentId)) return json(res, 404, { error: 'binding_not_found' });
        log('student_binding_reset', { studentId: bindingParams.studentId });
        return noContent(res);
      }

      if (req.method === 'POST' && pathname === '/v1/student/activate') {
        const clientIp = getClientIp(req, config.trustProxy);
        if (!activationLimiter.take(clientIp)) return json(res, 429, { error: 'too_many_attempts' });
        const body = await readJson(req, 4096);
        const studentId = config.activationCodes.get(String(body.code ?? ''));
        const deviceId = String(body.deviceId ?? '');
        if (!studentId || deviceId.length < 8 || deviceId.length > 256) return json(res, 401, { error: 'invalid_activation' });
        const activated = bindingStore.activate(studentId, deviceId, clientIp);
        if (!activated.ok) {
          const status = activated.reason === 'revoked' ? 403 : 409;
          return json(res, status, { error: activated.reason === 'revoked' ? 'activation_revoked' : 'activation_already_bound' });
        }
        const token = issueStudentToken(
          { studentId, deviceId, bindingId: activated.binding.bindingId },
          config.studentTokenSecret,
          config.studentTokenTtlMs,
        );
        log('student_activated', { studentId, bindingId: activated.binding.bindingId });
        return json(res, 200, { token, studentId });
      }

      if (req.method === 'POST' && pathname === '/v1/sessions') {
        const claims = authStudent(req, config, bindingStore);
        if (!claims) return json(res, 401, { error: 'unauthorized' });
        if (!sessionLimiter.take(claims.sub)) return json(res, 429, { error: 'session_rate_limited' });
        const body = await readJson(req, config.maxSupplementChars * 4 + 4096);
        const session = await sessionStore.create(claims.sub, String(body.supplement ?? ''));
        log('session_started', { sessionId: session.id, studentId: claims.sub, supplementCharacters: session.supplement.length });
        return json(res, 201, { id: session.id, expiresAt: new Date(session.expiresAt).toISOString() });
      }

      const answerParams = route(pathname, '/v1/sessions/:id/answer');
      if (req.method === 'POST' && answerParams) {
        const claims = authStudent(req, config, bindingStore);
        if (!claims) return json(res, 401, { error: 'unauthorized' });
        const session = sessionStore.get(answerParams.id, claims.sub);
        if (!session) return json(res, 404, { error: 'session_not_found' });
        await readJson(req, 2048);
        if (session.answerInProgress) return json(res, 409, { error: 'answer_in_progress' });
        if (!answerLimiter.take(claims.sub)) return json(res, 429, { error: 'answer_rate_limited' });
        const transcriptContext = sessionStore.answerContext(session);
        if (!transcriptContext.text.trim()) return json(res, 409, { error: 'no_transcript_yet' });
        session.answerInProgress = true;
        let master;
        try {
          master = await masterStore.get(session.studentId);
        } catch (error) {
          session.answerInProgress = false;
          throw error;
        }
        const controller = new AbortController();
        res.once('close', () => {
          if (!res.writableEnded) controller.abort();
        });
        startSse(res);
        try {
          const answer = await generateInterviewAnswer({
            config,
            master,
            session,
            transcriptContext: transcriptContext.text,
            signal: controller.signal,
            onToken: (token) => sendSse(res, 'token', { token }),
            onReplace: (text) => sendSse(res, 'replace', { text }),
            onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
              log('answer_retrying', {
                sessionId: session.id,
                studentId: claims.sub,
                attempt,
                maxAttempts,
                delayMs,
                ...error,
              });
              sendSse(res, 'retry', { attempt, maxAttempts });
            },
          });
          sessionStore.markAnswered(session, transcriptContext.revision);
          log('answer_generated', { sessionId: session.id, studentId: claims.sub, answerCharacters: answer.length });
          sendSse(res, 'done', { ok: true });
        } catch (error) {
          if (error?.name !== 'AbortError') {
            log('answer_failed', { sessionId: session.id, studentId: claims.sub, ...llmErrorDetails(error) });
            sendSse(res, 'error', { error: 'answer_generation_failed' });
          }
        } finally {
          session.answerInProgress = false;
          if (!res.writableEnded) res.end();
        }
        return;
      }

      const sessionParams = route(pathname, '/v1/sessions/:id');
      if (req.method === 'DELETE' && sessionParams) {
        const claims = authStudent(req, config, bindingStore);
        if (!claims) return json(res, 401, { error: 'unauthorized' });
        if (!sessionStore.end(sessionParams.id, claims.sub)) return json(res, 404, { error: 'session_not_found' });
        log('session_ended', { sessionId: sessionParams.id, studentId: claims.sub });
        return noContent(res);
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      const status = error?.statusCode ?? (/not configured|ENOENT/.test(String(error?.message)) ? 503 : 500);
      log('request_failed', { path: pathname, status, error: error?.message ?? 'unknown' });
      if (!res.headersSent) json(res, status, { error: error.publicCode ?? (status === 500 ? 'internal_error' : error.message) });
      else res.end();
    }
  });

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const params = route(requestUrl.pathname, '/v1/sessions/:id/audio');
    const claims = authStudent(req, config, bindingStore);
    const channel = requestUrl.searchParams.get('channel');
    const session = params && claims ? sessionStore.get(params.id, claims.sub) : null;
    if (!session || (channel !== 'system' && channel !== 'mic')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(req, socket, head, (ws) => {
      session.clientSockets.get(channel)?.close(1000, 'channel replaced');
      session.clientSockets.set(channel, ws);
      const stream = sessionStore.createAsr(session, channel);
      stream.on('status', (status) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'status', ...status })));
      stream.on('transcript', (event) => {
        sessionStore.addTranscript(session, channel, event);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
          type: 'transcript',
          channel,
          text: event.text,
          final: event.final,
          utteranceId: event.utteranceId,
          startTime: event.startTime,
        }));
      });
      stream.on('error', (error) => {
        log('stt_error', { sessionId: session.id, channel, error: error.message });
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'status', state: 'failed', error: 'stt_unavailable' }));
      });
      stream.on('close', () => {
        if (ws.readyState === ws.OPEN) ws.close(1012, 'upstream reconnect required');
      });
      ws.on('message', (audio, isBinary) => {
        if (isBinary && audio.length <= 16 * 1024) stream.sendAudio(audio);
      });
      ws.on('close', () => {
        stream.stop();
        if (session.audioStreams.get(channel) === stream) session.audioStreams.delete(channel);
        if (session.clientSockets.get(channel) === ws) session.clientSockets.delete(channel);
      });
      stream.start();
    });
  });

  return {
    server,
    masterStore,
    bindingStore,
    sessionStore,
    async close() {
      sessionStore.close();
      for (const client of websocketServer.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
