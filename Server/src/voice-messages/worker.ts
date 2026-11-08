import { spawn } from 'node:child_process';
import type { Transcribe } from './service.js';

/** No shell or remote endpoint. A local model directory is required; downloads are disabled. */
export function localWhisperWorker(python: string, script: string, model: string): Transcribe {
  return (file, signal) => new Promise((resolve, reject) => {
    if (!python || !script || !model) { reject(new Error('worker-unavailable')); return; }
    const child = spawn(python, [script, file, model], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1' },
    });
    let output = ''; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); return; }
      try {
        const value: unknown = JSON.parse(output);
        if (typeof value !== 'object' || !value || !('text' in value) || typeof value.text !== 'string' || !('duration' in value) || typeof value.duration !== 'number') throw new Error('invalid-output');
        resolve({ text: value.text, duration: value.duration });
      } catch { reject(new Error('transcription-failed')); }
    };
    const abort = () => { finish(new Error('aborted')); };
    const timer = setTimeout(() => { finish(new Error('timeout')); }, 10 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { output += data; if (Buffer.byteLength(output) > 100_000) finish(new Error('invalid-output')); });
    child.on('error', () => { finish(new Error('worker-unavailable')); });
    child.on('close', code => { finish(code === 0 ? undefined : new Error(code === 2 ? 'invalid-audio' : 'transcription-failed')); });
  });
}
