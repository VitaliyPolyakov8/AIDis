import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { localWhisperWorker } from '../src/voice-messages/worker.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function script(source: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aidis-worker-')); dirs.push(dir);
  const file = path.join(dir, 'worker.cjs'); await writeFile(file, source); return file;
}
describe('local transcription subprocess boundary', () => {
  it('preserves Russian text when UTF-8 characters cross stdout chunks', async () => {
    const file = await script(`const out = Buffer.from(JSON.stringify({text:'Привет',duration:2})); process.stdout.write(out.subarray(0,10)); setTimeout(() => process.stdout.write(out.subarray(10)), 100);`);
    await expect(localWhisperWorker(process.execPath, file, 'local-model')('audio-file', new AbortController().signal)).resolves.toEqual({ text: 'Привет', duration: 2 });
  });
  it('rejects invalid audio, bounded output, malformed results and offline workers', async () => {
    for (const source of [`process.exit(2)`, `process.stdout.write('a'.repeat(100001))`, `process.stdout.write('{}')`]) {
      await expect(localWhisperWorker(process.execPath, await script(source), 'local-model')('audio', new AbortController().signal)).rejects.toThrow();
    }
    await expect(localWhisperWorker('', '', '')('audio', new AbortController().signal)).rejects.toThrow('worker-unavailable');
  });
  it('aborts an active local process', async () => {
    const worker = localWhisperWorker(process.execPath, await script(`setInterval(() => {}, 1000)`), 'local-model');
    const controller = new AbortController(); const result = worker('audio', controller.signal); controller.abort();
    await expect(result).rejects.toThrow('aborted');
  });
});
