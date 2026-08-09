import { createApplication } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApplication(config);

app.server.listen(config.port, config.host, () => {
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event: 'server_started',
    address: `${config.host}:${config.port}`,
    sttProvider: config.sttProvider,
  })}\n`);
});

async function shutdown() {
  await app.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
