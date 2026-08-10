import { loadConfig } from '../src/config.js';

const command = process.argv[2];
const studentId = process.argv[3];
const config = loadConfig();
const baseUrl = process.env.ADMIN_SERVER_URL?.replace(/\/$/, '') ?? `http://127.0.0.1:${config.port}`;
const headers = { 'x-admin-key': config.adminApiKey };

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Binding command failed (${response.status}): ${body.error ?? 'unknown_error'}`);
  }
  return response;
}

if (command === 'list') {
  const response = await request('/v1/admin/student-bindings');
  process.stdout.write(`${JSON.stringify((await response.json()).bindings, null, 2)}\n`);
} else if (command === 'revoke' && studentId) {
  await request(`/v1/admin/student-bindings/${encodeURIComponent(studentId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'revoke' }),
  });
  process.stdout.write(`Revoked binding for ${studentId}.\n`);
} else if (command === 'reset' && studentId) {
  await request(`/v1/admin/student-bindings/${encodeURIComponent(studentId)}`, { method: 'DELETE' });
  process.stdout.write(`Reset binding for ${studentId}.\n`);
} else {
  process.stderr.write('Usage: node scripts/manage-bindings.mjs <list|revoke|reset> [studentId]\n');
  process.exitCode = 2;
}
