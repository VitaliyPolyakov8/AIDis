import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), channel: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
vi.mock('electron', () => ({ MessageChannelMain: mocked.channel }));
vi.mock('../src/main/config', () => ({ ASSETS_DIR: 'C:/app/assets' }));
vi.mock('../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const { AppAudio } = await import('../src/main/appAudio');

describe('application audio helper replacement', () => {
  const children: ReturnType<typeof makeChild>[] = [];
  const ports: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  function makeChild() {
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn() });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    children.length = 0;
    ports.length = 0;
    mocked.spawn.mockImplementation(() => {
      const child = makeChild();
      children.push(child);
      return child;
    });
    mocked.channel.mockImplementation(function () {
      const port1 = { postMessage: vi.fn(), close: vi.fn() };
      ports.push(port1);
      return { port1, port2: {} };
    });
  });
  afterEach(() => vi.useRealTimers());

  it('never forwards buffered PCM from the replaced helper into the newly selected window', async () => {
    const capture = new AppAudio();
    const target = { postMessage: vi.fn() } as unknown as Electron.WebContents;
    const first = capture.start('window:1:0', target);
    children[0]!.stderr.write('ready 48000 2\n');
    expect(await first).toEqual({ ok: true });
    const second = capture.start('window:2:0', target);
    children[1]!.stderr.write('ready 48000 2\n');
    expect(await second).toEqual({ ok: true });
    children[0]!.stdout.write(Buffer.alloc(8, 1));
    expect(ports[1]!.postMessage).not.toHaveBeenCalled();
    children[0]!.emit('exit', 0);
    children[1]!.stdout.write(Buffer.alloc(8, 2));
    expect(ports[1]!.postMessage).toHaveBeenCalledOnce();
    expect([...new Uint8Array(ports[1]!.postMessage.mock.calls[0]![0] as ArrayBuffer)]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(ports[1]!.close).not.toHaveBeenCalled();
    capture.stop();
  });
});
