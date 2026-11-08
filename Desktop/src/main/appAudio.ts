import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { MessageChannelMain, type WebContents } from 'electron';
import { ASSETS_DIR } from './config';
import { logger } from './logger';

/**
 * 0.4.5 application-only stream audio.
 *
 * Runs assets/native/aidis-app-audio.exe for the chosen capture window. The helper uses the
 * documented Windows process-loopback API (ActivateAudioInterfaceAsync with
 * AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, include the target process tree) and writes raw
 * 48 kHz float stereo PCM to stdout, which is forwarded to the page over a MessagePort.
 * Nothing is injected into the game, no hooks, no memory access, no drivers.
 * One capture at a time (one stream per person); a new start replaces the old one.
 */
const HELPER = join(ASSETS_DIR, 'native', 'aidis-app-audio.exe');
const WINDOW_SOURCE = /^window:(\d+):\d+$/;

export function hwndFromSourceId(sourceId: unknown): string | null {
  if (typeof sourceId !== 'string') return null;
  return WINDOW_SOURCE.exec(sourceId)?.[1] ?? null;
}

export class AppAudio {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private port: Electron.MessagePortMain | null = null;

  async start(sourceId: unknown, target: WebContents): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.stop();
    if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
    const hwnd = hwndFromSourceId(sourceId);
    if (!hwnd) return { ok: false, reason: 'not-a-window' };
    const child = spawn(HELPER, ['--hwnd', hwnd], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const ready = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      let err = '';
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 4000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'missing' });
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve({ ok: false, reason: /0x80070032|0x88890002|E_NOTIMPL/i.test(err) ? 'os-unsupported' : 'error' });
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        if (/^ready /m.test(err)) {
          clearTimeout(timer);
          resolve({ ok: true });
        } else if (/^error /m.test(err)) {
          logger.warn('stream', `Application audio helper: ${err.trim().slice(0, 200)}`);
        }
      });
    });
    if (!ready.ok || this.child !== child) {
      if (this.child === child) this.stop();
      logger.warn('stream', `Application audio unavailable (${ready.ok ? 'replaced' : ready.reason})`);
      return ready.ok ? { ok: false, reason: 'replaced' } : ready;
    }
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    target.postMessage('app-audio:port', null, [port2]);
    // Whole float frames only (8 bytes per stereo frame); the remainder waits for the next chunk.
    let rest: Buffer = Buffer.alloc(0);
    child.stdout.on('data', (data: Buffer) => {
      // A replaced helper can drain stdout while it shuts down. Its PCM belongs only to its port.
      if (this.child !== child || this.port !== port1) return;
      const all: Buffer = rest.length ? Buffer.concat([rest, data]) : data;
      const usable = all.length - (all.length % 8);
      rest = all.subarray(usable);
      if (usable === 0) return;
      const copy = new ArrayBuffer(usable);
      new Uint8Array(copy).set(all.subarray(0, usable));
      port1.postMessage(copy);
    });
    child.on('exit', () => {
      if (this.child === child) this.stop();
    });
    logger.info('stream', 'Application audio capture running (process loopback)');
    return { ok: true };
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 1000).unref();
    }
    this.port?.close();
    this.port = null;
  }
}
