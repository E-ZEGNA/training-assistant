import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function requireAdmin(req, config) {
  return sameSecret(req.headers['x-admin-key'], config.adminApiKey);
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueStudentToken({ studentId, deviceId, bindingId }, secret, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    sub: studentId,
    device: createHash('sha256').update(deviceId).digest('base64url'),
    binding: bindingId,
    exp: Date.now() + ttlMs,
  })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyStudentToken(token, secret) {
  if (typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !sameSecret(signature, sign(payload, secret))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.v !== 1 || typeof claims.sub !== 'string' || typeof claims.binding !== 'string'
      || !Number.isFinite(claims.exp) || claims.exp <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function verifyStudentDevice(claims, deviceId) {
  if (!claims || typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 256) return false;
  const actual = createHash('sha256').update(deviceId).digest('base64url');
  return sameSecret(claims.device, actual);
}

export function bearerToken(req) {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}
