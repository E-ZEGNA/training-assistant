import { loadConfig } from '../src/config.js';
import { MasterPackStore } from '../src/crypto-store.js';
import { generateInterviewAnswer } from '../src/llm.js';

const config = loadConfig();
if (config.llm.provider !== 'codex-config') throw new Error('smoke:codex requires LLM_PROVIDER=codex-config');
const store = new MasterPackStore(config.dataDir, config.masterEncryptionKey);
const master = await store.get();
const session = {
  supplement: '本场应聘 ML Infra，回答要口语化并突出资源治理。',
  answerHistory: [],
};
const answer = await generateInterviewAnswer({
  config,
  master,
  session,
  transcriptContext: '面试官：你做过的 GPU 调度优化具体解决了什么问题，结果怎么样？',
});
process.stdout.write(`${answer}\n`);
