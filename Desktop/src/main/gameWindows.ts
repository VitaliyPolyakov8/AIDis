import { execFile } from 'node:child_process';
import { app } from 'electron';
import type { GameInfo } from './gameDetector';
import { logger } from './logger';

/**
 * 0.4.1 "Stream <game>" and the local game icon. Read-only, like the detector: PowerShell's
 * Get-Process lists processes that own a top-level window (id, image name, main window handle,
 * executable path, title). Nothing is opened, injected or hooked; the result never leaves this PC.
 */
export interface WindowedProcess {
  pid: number;
  /** Image name without ".exe", as Get-Process reports it. */
  name: string;
  /** Main window handle (HWND) as a decimal string: desktopCapturer window ids are "window:<hwnd>:0". */
  hwnd: string;
  path: string | null;
  title: string;
}

const PS_SCRIPT = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,@{n='Hwnd';e={[int64]$_.MainWindowHandle}},Path,MainWindowTitle | ConvertTo-Json -Compress";

/** Parses the PowerShell JSON (one object or an array) into WindowedProcess rows. */
export function parseWindowedProcesses(json: string): WindowedProcess[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : [data];
  const out: WindowedProcess[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const pid = Number(r.Id);
    const hwnd = Number(r.Hwnd);
    if (!Number.isInteger(pid) || !Number.isFinite(hwnd) || hwnd === 0 || typeof r.ProcessName !== 'string') continue;
    out.push({
      pid,
      name: r.ProcessName,
      hwnd: String(hwnd),
      path: typeof r.Path === 'string' && r.Path !== '' ? r.Path : null,
      title: typeof r.MainWindowTitle === 'string' ? r.MainWindowTitle : '',
    });
  }
  return out;
}

export function listWindowedProcesses(): Promise<WindowedProcess[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) logger.warn('activity', 'Could not list windowed processes');
      resolve(error ? [] : parseWindowedProcesses(stdout));
    });
  });
}

/** Lower-case, trademark signs and punctuation removed: "PowerWash Simulator 2™" -> "powerwash simulator 2". */
export function normalizeTitle(value: string): string {
  return value
    .replace(/[™®©]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isInside(path: string, dir: string): boolean {
  const p = path.toLowerCase().replace(/\//g, '\\');
  const d = dir.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  return p.startsWith(`${d}\\`);
}

/**
 * Processes that belong to the game, strongest evidence first: the executable lives in the game's
 * Steam folder, or its image name is the detected one. The window title is only a fallback and
 * must equal the game name (after normalisation), never just contain it, so a browser tab or a
 * chat window that mentions the game does not match.
 */
export function matchGameProcesses(game: Pick<GameInfo, 'name' | 'exe' | 'installDir'>, processes: readonly WindowedProcess[]): WindowedProcess[] {
  const byFolder = game.installDir ? processes.filter((p) => p.path !== null && isInside(p.path, game.installDir ?? '')) : [];
  if (byFolder.length > 0) return byFolder;
  const exe = game.exe?.toLowerCase();
  const byExe = exe ? processes.filter((p) => `${p.name.toLowerCase()}.exe` === exe) : [];
  if (byExe.length > 0) return byExe;
  const wanted = normalizeTitle(game.name);
  return wanted ? processes.filter((p) => normalizeTitle(p.title) === wanted) : [];
}

/** The capture source id of the game's window, if one of the listed sources is it. */
export function pickGameSource(sourceIds: readonly { id: string; name: string }[], game: Pick<GameInfo, 'name' | 'exe' | 'installDir'>, processes: readonly WindowedProcess[]): string | null {
  const matched = matchGameProcesses(game, processes);
  for (const proc of matched) {
    const source = sourceIds.find((s) => s.id.startsWith(`window:${proc.hwnd}:`));
    if (source) return source.id;
  }
  // No process evidence (e.g. PowerShell unavailable): a window whose title IS the game name.
  const wanted = normalizeTitle(game.name);
  const byTitle = wanted ? sourceIds.filter((s) => s.id.startsWith('window:') && normalizeTitle(s.name) === wanted) : [];
  return byTitle.length === 1 ? (byTitle[0]?.id ?? null) : null;
}

const iconCache = new Map<string, string | null>();

/** The game's executable icon as a data URL (local display only; never uploaded anywhere). */
export async function gameIcon(game: Pick<GameInfo, 'name' | 'exe' | 'installDir'>): Promise<string | null> {
  const proc = matchGameProcesses(game, await listWindowedProcesses()).find((p) => p.path);
  if (!proc?.path) return null;
  const key = proc.path.toLowerCase();
  if (!iconCache.has(key)) {
    try {
      const icon = await app.getFileIcon(proc.path, { size: 'normal' });
      iconCache.set(key, icon.isEmpty() ? null : icon.toDataURL());
    } catch {
      iconCache.set(key, null);
    }
  }
  return iconCache.get(key) ?? null;
}
