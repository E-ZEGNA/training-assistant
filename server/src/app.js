import http from 'node:http';
import { WebSocketServer } from 'ws';
import { bearerToken, issueStudentToken, requireAdmin, verifyStudentDevice, verifyStudentToken } from './auth.js';
import { MasterPackStore } from './crypto-store.js';
import { generateInterviewAnswer } from './llm.js';
import { json, noContent, RateLimiter, readJson, route } from './http-utils.js';
import { SessionStore } from './sessions.js';

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}

function authStudent(req, config) {
  const claims = verifyStudentToken(bearerToken(req), config.studentTokenSecret);
  return verifyStudentDevice(claims, req.headers['x-device-id']) ? claims : null;
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
  const sessionStore = new SessionStore(config, masterStore);
  const activationLimiter = new RateLimiter({ limit: 8, windowMs: 15 * 60_000 });
  const answerLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const { pathname } = requestUrl;
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (req.method === 'GET' && pathname === '/health') {
        const status = await masterStore.status();
        return json(res, 200, { ok: true, masterPackConfigured: status.configured, sttProvider: config.sttProvider });
      }

      if (req.method === 'GET' && pathname === '/v1/admin/master-pack/status') {
        if (!requireAdmin(req, config)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, await masterStore.status());
      }

      if (req.method === 'PUT' && pathname === '/v1/admin/master-pack') {
        if (!requireAdmin(req, config)) return json(res, 401, { error: 'unauthorized' });
        const body = await readJson(req, 2_100_000);
        const version = String(body.version ?? new Date().toISOString());
        const result = await masterStore.put({ text: body.text, version });
        log('master_pack_published', { version: result.version, characters: result.characters });
        return json(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/v1/student/activate') {
        const remote = req.socket.remoteAddress ?? 'unknown';
        if (!activationLimiter.take(remote)) return json(res, 429, { error: 'too_many_attempts' });
        const body = await readJson(req, 4096);
        const studentId = config.activationCodes.get(String(body.code ?? ''));
        const deviceId = String(body.deviceId ?? '');
        if (!studentId || deviceId.length < 8 || deviceId.length > 256) return json(res, 401, { error: 'invalid_activation' });
        const token = issueStudentToken({ studentId, deviceId }, config.studentTokenSecret);
        log('student_activated', { studentId });
        return json(res, 200, { token, studentId });
      }

      if (req.method === 'POST' && pathname === '/v1/sessions') {
        const claims = authStudent(req, config);
        if (!claims) return json(res, 401, { error: 'unauthorized' });
        const body = await readJson(req, config.maxSupplementChars + 4096);
        const session = await sessionStore.create(claims.sub, String(body.supplement ?? ''));
        log('session_started', { sessionId: session.id, studentId: claims.sub, supplementCharacters: session.supplement.length });
        return json(res, 201, { id: session.id, expiresAt: new Date(session.expiresAt).toISOString() });
      }

      const answerParams = route(pathname, '/v1/sessions/:id/answer');
      if (req.method === 'POST' && answerParams) {
        const claims = authStudent(req, config);
        if (!claims) return json(res, 401, { error: 'unauthorized' });
        if (!answerLimiter.take(claims.sub)) return json(res, 429, { error: 'answer_rate_limited' });
        const session = sessionStore.get(answerParams.id, claims.sub);
        if (!session) return json(res, 404, { error: 'session_not_found' });
        await readJson(req, 2048);
        const transcriptContext = sessionStore.context(session);
        if (!transcriptContext.text.trim()) return json(res, 409, { error: 'no_transcript_yet' });
        const master = await masterStore.get();
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
          });
          sessionStore.markAnswered(session, transcriptContext.revision);
          log('answer_generated', { sessionId: session.id, studentId: claims.sub, answerCharacters: answer.length });
          sendSse(res, 'done', { ok: true });
        } catch (error) {
          if (error?.name !== 'AbortError') {
            log('answer_failed', { sessionId: session.id, studentId: claims.sub, error: error?.message ?? 'unknown' });
            sendSse(res, 'error', { error: 'answer_generation_failed' });
          }
        } finally {
          if (!res.writableEnded) res.end();
        }
        return;
      }

      const sessionParams = route(pathname, '/v1/sessions/:id');
      if (req.method === 'DELETE' && sessionParams) {
        const claims = authStudent(req, config);
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
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal_error' : error.message });
      else res.end();
    }
  });

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const params = route(requestUrl.pathname, '/v1/sessions/:id/audio');
    const claims = authStudent(req, config);
    const channel = requestUrl.searchParams.get('channel');
    const session = params && claims ? sessionStore.get(params.id, claims.sub) : null;
    if (!session || (channel !== 'system' && channel !== 'mic')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(req, socket, head, (ws) => {
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
      });
      stream.start();
    });
  });

  return {
    server,
    masterStore,
    sessionStore,
    async close() {
      sessionStore.close();
      for (const client of websocketServer.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
