import { isIP } from 'node:net';

export function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.includes(',')) return null;
  if (candidate.startsWith('::ffff:') && isIP(candidate.slice(7)) === 4) return candidate.slice(7);
  return isIP(candidate) ? candidate : null;
}

export function getClientIp(req, trustProxy = false) {
  const direct = normalizeIp(req.socket?.remoteAddress) ?? 'unknown';
  if (!trustProxy) return direct;
  const forwarded = req.headers?.['x-real-ip'];
  if (Array.isArray(forwarded)) return direct;
  return normalizeIp(forwarded) ?? direct;
}
