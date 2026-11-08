import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { APP_ROOT, OVERLAY_PRELOAD_PATH } from './config';
import { IPC } from '../shared/ipc';

export type StreamHint = { sourceId: string; expiresAt?: number } & ({ type: 'pointer'; x: number; y: number } | { type: 'reaction'; reaction: 'laugh' | 'clap' | 'f' });
export function sanitizeStreamHint(value: unknown): StreamHint | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.expiresAt !== undefined && (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt))) return null;
  const deadline = typeof v.expiresAt === 'number' ? { expiresAt: v.expiresAt } : {};
  if (typeof v.sourceId !== 'string' || !/^(window|screen):[0-9]+:[0-9]+$/.test(v.sourceId)) return null;
  if (v.type === 'reaction' && (v.reaction === 'laugh' || v.reaction === 'clap' || v.reaction === 'f')) return { sourceId: v.sourceId, type: v.type, reaction: v.reaction, ...deadline };
  if (v.type !== 'pointer' || typeof v.x !== 'number' || typeof v.y !== 'number' || !Number.isFinite(v.x) || !Number.isFinite(v.y) || v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1) return null;
  return { sourceId: v.sourceId, type: v.type, x: v.x, y: v.y, ...deadline };
}
export const hintPosition = (bounds: Rectangle, x: number, y: number) => ({ x: Math.round(bounds.x + bounds.width * x), y: Math.round(bounds.y + bounds.height * y) });

/** Read the visible frame of the foreground captured window. No injection or game access. */
export function foregroundWindowBounds(sourceId: string): Promise<Rectangle | null> {
  const hwnd = /^window:([0-9]+):[0-9]+$/.exec(sourceId)?.[1];
  if (!hwnd || process.platform !== 'win32') return Promise.resolve(null);
  // The sole substitution is digits validated above. No title, path or user-supplied shell code.
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AidisHintFrame {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr w,int a,out R r,int s);
}
'@
$targetWindow=[IntPtr]::new([long]${hwnd})
if ([AidisHintFrame]::GetForegroundWindow() -ne $targetWindow -or [AidisHintFrame]::IsIconic($targetWindow)) { exit }
$frame=New-Object AidisHintFrame+R
if ([AidisHintFrame]::DwmGetWindowAttribute($targetWindow,9,[ref]$frame,16) -eq 0) { @{x=$frame.Left;y=$frame.Top;width=($frame.Right-$frame.Left);height=($frame.Bottom-$frame.Top)} | ConvertTo-Json -Compress }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 2000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        const r = JSON.parse(stdout) as Rectangle;
        if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) {
          resolve(null);
          return;
        }
        resolve(screen.screenToDipRect(null, r));
      } catch {
        resolve(null);
      }
    });
  });
}

/** One short-lived click-through marker. No idle polling, network or credentials. */
export class StreamHints {
  private win: BrowserWindow | null = null;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastAt = 0;
  private pending = false;
  constructor(private readonly bounds: (sourceId: string) => Promise<Rectangle | null>) {}

  async show(value: unknown): Promise<void> {
    if (value === null) {
      this.clear();
      return;
    }
    const hint = sanitizeStreamHint(value);
    const now = Date.now();
    if (!hint || this.pending || now - this.lastAt < 250) return;
    const deadline = Math.min(hint.expiresAt ?? now + 2000, now + 2000);
    if (deadline <= now) return;
    this.lastAt = now;
    this.pending = true;
    const epoch = ++this.epoch;
    const bounds = await this.bounds(hint.sourceId).catch(() => null);
    this.pending = false;
    if (!bounds || epoch !== this.epoch || Date.now() >= deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.win?.destroy();
    const point = hintPosition(bounds, hint.type === 'pointer' ? hint.x : 0.5, hint.type === 'pointer' ? hint.y : 0.85);
    const win = new BrowserWindow({
      width: 80,
      height: 80,
      x: point.x - 40,
      y: point.y - 40,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { preload: OVERLAY_PRELOAD_PATH, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    this.win = win;
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    // Prevent screen capture from recursively rebroadcasting a marker to viewers.
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.once('did-finish-load', () => {
      if (this.win !== win || win.isDestroyed() || epoch !== this.epoch) return;
      if (Date.now() >= deadline) {
        this.clear();
        return;
      }
      win.webContents.send(IPC.overlayUpdate, { type: 'stream-hint', hint });
      win.showInactive();
      this.timer = setTimeout(() => this.clear(), deadline - Date.now());
    });
    void win.loadFile(join(APP_ROOT, 'build', 'overlay', 'hint.html')).catch(() => {
      if (this.win === win && epoch === this.epoch) this.clear();
    });
  }

  clear(): void {
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.win?.destroy();
    this.win = null;
  }
}
