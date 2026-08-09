import { readFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const file = arg('--file');
const server = (arg('--server') ?? process.env.PUBLISH_SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const key = arg('--key') ?? process.env.ADMIN_API_KEY;
const version = arg('--version') ?? new Date().toISOString();

if (!file || !key) {
  process.stderr.write('Usage: npm run publish-master -- --file <path> --server <url> --key <admin-key> [--version <version>]\n');
  process.exit(2);
}

const text = await readFile(path.resolve(file), 'utf8');
const response = await fetch(`${server}/v1/admin/master-pack`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'x-admin-key': key },
  body: JSON.stringify({ text, version }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  process.stderr.write(`Publish failed (${response.status}): ${body.error ?? 'unknown error'}\n`);
  process.exit(1);
}
process.stdout.write(`Published master pack version ${body.version} (${body.characters} characters).\n`);
