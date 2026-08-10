import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SeedAsrStream } from '../src/seed-asr.js';

function wavPcm(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('ASR smoke input must be a WAV file');
  }
  let offset = 12;
  let format;
  let audio;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      format = {
        codec: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') audio = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !audio || format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16_000 || format.bits !== 16) {
    throw new Error('ASR smoke WAV must be PCM16, 16 kHz, mono');
  }
  return audio;
}

const input = process.argv[2];
if (!input) throw new Error('Usage: npm run smoke:asr -- <pcm16-16khz-mono.wav>');
const config = loadConfig();
if (config.sttProvider !== 'seed-asr' || !config.seedAsr.apiKey) throw new Error('Seed-ASR is not configured');
const audio = wavPcm(await readFile(path.resolve(input)));
const stream = new SeedAsrStream({ ...config.seedAsr, uid: 'server-asr-smoke', hotwords: [] });
const transcripts = [];
let failure;
stream.on('transcript', (event) => transcripts.push(event));
stream.on('error', (error) => { failure = error; });

const connected = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Seed-ASR connection timed out')), 15_000);
  stream.on('status', ({ state }) => {
    if (state === 'connected') {
      clearTimeout(timer);
      resolve();
    }
  });
  stream.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});
stream.start();
await connected;
for (let offset = 0; offset < audio.length; offset += 3_200) {
  if (failure) throw failure;
  stream.sendAudio(audio.subarray(offset, offset + 3_200));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
stream.sendAudio(Buffer.alloc(19_200));
await new Promise((resolve) => setTimeout(resolve, 1_500));
stream.stop();
if (failure) throw failure;
const latest = transcripts.at(-1);
if (!latest?.text) throw new Error('Seed-ASR returned no transcript');
process.stdout.write(`ASR smoke passed (${latest.text.length} characters, final=${Boolean(latest.final)}).\n`);
