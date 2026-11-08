import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.4.1', getFileIcon: vi.fn() },
  BrowserWindow: vi.fn(),
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
  screen: { on: vi.fn(), off: vi.fn() },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { parseAppManifestInstallDir, nextGameInfo, matchKnownGameExe, KNOWN_STEAM_IDS, KNOWN_GAMES } = await import('../src/main/gameDetector');
const { parseWindowedProcesses, matchGameProcesses, pickGameSource, normalizeTitle } = await import('../src/main/gameWindows');
const { sanitizeOverlayState } = await import('../src/main/overlay');
const { buildCsp } = await import('../src/main/protocol');
const SERVER = {
  origin: 'https://chat.example.com',
  name: 'chat.example.com',
  config: { serverVersion: '1.0.0', livekitUrl: 'wss://rtc.chat.example.com', voiceNodeDomain: 'chat.example.com', steamArt: true, minimumVersion: '', updateMirrorUrl: null },
};
const CONTENT_SECURITY_POLICY = buildCsp(SERVER);

describe('0.4.1 game info (AppID, start time)', () => {
  it('reads the Steam install folder name safely', () => {
    expect(parseAppManifestInstallDir('"AppState"\n{\n\t"appid"\t\t"1290000"\n\t"installdir"\t\t"PowerWash Simulator 2"\n}')).toBe('PowerWash Simulator 2');
    expect(parseAppManifestInstallDir('"installdir" "..\\\\Windows"')).toBeNull();
    expect(parseAppManifestInstallDir('nothing')).toBeNull();
  });

  it('startedAt: none -> game sets it, re-scans keep it, game A -> game B resets it, closing clears it', () => {
    const a = nextGameInfo(null, { name: 'Helldivers 2', steamAppId: 553850, exe: null, installDir: null }, 1000);
    expect(a?.startedAt).toBe(1000);
    const rescan = nextGameInfo(a, { name: 'Helldivers 2', steamAppId: null, exe: 'helldivers2.exe', installDir: null }, 5000);
    expect(rescan).toMatchObject({ startedAt: 1000, steamAppId: 553850, exe: 'helldivers2.exe' });
    const b = nextGameInfo(rescan, { name: 'Elden Ring', steamAppId: 1245620, exe: null, installDir: null }, 9000);
    expect(b?.startedAt).toBe(9000);
    expect(nextGameInfo(b, null, 10_000)).toBeNull();
  });

  it('known executables map to their Steam AppIDs (artwork without Steam running)', () => {
    expect(matchKnownGameExe(['explorer.exe', 'eldenring.exe'])).toEqual({ name: 'Elden Ring', exe: 'eldenring.exe' });
    expect(KNOWN_STEAM_IDS['Elden Ring']).toBe(1245620);
    // Every AppID belongs to a game the table can actually detect.
    const names = new Set(Object.values(KNOWN_GAMES));
    for (const name of Object.keys(KNOWN_STEAM_IDS)) expect(names.has(name), name).toBe(true);
  });
});

describe('0.4.1 "Stream <game>" window matching', () => {
  const json = JSON.stringify([
    { Id: 100, ProcessName: 'chrome', Hwnd: 2001, Path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe', MainWindowTitle: 'PowerWash Simulator 2 - Steam News - Google Chrome' },
    { Id: 200, ProcessName: 'PowerWashSimulator2', Hwnd: 3001, Path: 'D:\\SteamLibrary\\steamapps\\common\\PowerWash Simulator 2\\PowerWashSimulator2.exe', MainWindowTitle: 'PowerWash Simulator 2' },
    { Id: 300, ProcessName: 'eldenring', Hwnd: 4001, Path: null, MainWindowTitle: 'ELDEN RING™' },
    { Id: 400, ProcessName: 'idle', Hwnd: 0, Path: null, MainWindowTitle: '' },
  ]);
  const procs = parseWindowedProcesses(json);
  const sources = [
    { id: 'screen:0:0', name: 'Entire screen' },
    { id: 'window:2001:0', name: 'PowerWash Simulator 2 - Steam News - Google Chrome' },
    { id: 'window:3001:0', name: 'PowerWash Simulator 2' },
    { id: 'window:4001:0', name: 'ELDEN RING™' },
  ];

  it('parses PowerShell output (array or single object) and drops windowless rows', () => {
    expect(procs.map((p) => p.pid)).toEqual([100, 200, 300]);
    expect(parseWindowedProcesses(JSON.stringify({ Id: 1, ProcessName: 'x', Hwnd: 5, Path: '', MainWindowTitle: 't' }))).toHaveLength(1);
    expect(parseWindowedProcesses('not json')).toEqual([]);
  });

  it('Steam game: matched by its install folder, not by a browser tab that mentions it', () => {
    const game = { name: 'PowerWash Simulator 2', exe: null, installDir: 'D:/SteamLibrary/steamapps/common/PowerWash Simulator 2' };
    expect(matchGameProcesses(game, procs).map((p) => p.pid)).toEqual([200]);
    expect(pickGameSource(sources, game, procs)).toBe('window:3001:0');
  });

  it('known executable: matched by image name', () => {
    expect(pickGameSource(sources, { name: 'Elden Ring', exe: 'eldenring.exe', installDir: null }, procs)).toBe('window:4001:0');
  });

  it('title fallback must equal the game name (no substring), else no preselection', () => {
    expect(normalizeTitle('ELDEN RING™')).toBe('elden ring');
    // No process info (PowerShell failed): exact title only.
    expect(pickGameSource(sources, { name: 'Elden Ring', exe: null, installDir: null }, [])).toBe('window:4001:0');
    expect(pickGameSource(sources, { name: 'Steam News', exe: null, installDir: null }, [])).toBeNull();
    expect(pickGameSource(sources, { name: 'Unknown Game', exe: 'nope.exe', installDir: null }, procs)).toBeNull();
  });
});

describe('0.4.1 overlay frame + CSP', () => {
  it('allows no frames and no remote scripts', () => {
    const frame = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('frame-src'));
    const script = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('script-src'));
    expect(frame).toBe("frame-src 'none'");
    expect(script).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });
  it('passes only known profile frames to the overlay', () => {
    const base = { id: 'u1', name: 'A', avatar: null, color: '#fff', initials: 'A', speaking: true, micMuted: false, deafened: false, isSelf: false };
    const state = sanitizeOverlayState({
      inCall: true,
      channelName: 'x',
      micEnabled: true,
      deafened: false,
      participants: [
        { ...base, frame: 'neon' },
        { ...base, id: 'u2', frame: '<script>' },
      ],
    });
    expect(state?.participants.map((p) => p.frame)).toEqual(['neon', null]);
  });

  it('allows Steam artwork images (img-src only) when the server switched them on', () => {
    const img = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('img-src')) ?? '';
    const connect = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('connect-src')) ?? '';
    expect(img).toContain('https://cdn.cloudflare.steamstatic.com');
    expect(img).toContain('https://shared.cloudflare.steamstatic.com');
    expect(connect).not.toContain('steamstatic');
  });
});
