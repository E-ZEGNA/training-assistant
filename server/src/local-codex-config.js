import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

export async function loadLocalCodexCredentials(llmConfig) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = llmConfig.codexConfigPath || path.join(codexHome, 'config.toml');
  const authPath = llmConfig.codexAuthPath || path.join(codexHome, 'auth.json');
  const [configurationText, authText] = await Promise.all([
    readFile(configPath, 'utf8'),
    readFile(authPath, 'utf8'),
  ]);
  const configuration = parse(configurationText);
  const auth = JSON.parse(authText);
  const providerId = configuration.model_provider;
  const provider = configuration.model_providers?.[providerId];
  if (!providerId || !provider?.base_url) throw new Error('Local Codex configuration has no active provider base_url');
  if (typeof auth.OPENAI_API_KEY !== 'string' || !auth.OPENAI_API_KEY.trim()) {
    throw new Error('Local Codex auth.json has no OPENAI_API_KEY');
  }
  const baseUrl = String(provider.base_url).replace(/\/$/, '');
  if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(baseUrl)) {
    throw new Error('Local Codex provider must use HTTPS or localhost');
  }
  return {
    baseUrl,
    wireApi: provider.wire_api ?? 'responses',
    model: configuration.model,
    apiKey: auth.OPENAI_API_KEY.trim(),
  };
}
