import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.3.0' },
  BrowserWindow: vi.fn(),
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
  screen: { on: vi.fn(), off: vi.fn() },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { parseRegValue, parseTasklist, parseLibraryFolders, parseAppManifestName, matchKnownGame, cleanGameName } = await import('../src/main/gameDetector');
const { computeOverlayBounds, computeChatBounds, sanitizeOverlayState, sanitizeOverlayMessage, sanitizeOverlayReply } = await import('../src/main/overlay');
const { DEFAULT_OVERLAY, applySettingsPatch, DEFAULT_DESKTOP_SETTINGS, publicGameName, sanitizeOverlay } = await import('../../Client/src/desktop/contract');

describe('game detection parsers (external, read-only)', () => {
  it('reads Steam registry values', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    RunningAppID    REG_DWORD    0x8b1e2\r\n\r\n';
    expect(parseRegValue(out, 'RunningAppID')).toBe(String(0x8b1e2));
    expect(parseRegValue('\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n', 'SteamPath')).toBe('c:/program files (x86)/steam');
    expect(parseRegValue('ERROR: not found', 'RunningAppID')).toBeNull();
  });

  it('resolves names from Steam library files', () => {
    const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}';
    expect(parseLibraryFolders(vdf)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
    expect(parseAppManifestName('"AppState"\n{\n\t"appid"\t\t"553850"\n\t"name"\t\t"HELLDIVERS™ 2"\n}')).toBe('HELLDIVERS 2');
    expect(cleanGameName('  ELDEN RING®  ')).toBe('ELDEN RING');
  });

  it('matches only known games from process image names; unknown programs stay private', () => {
    const tasklist = '"System Idle Process","0","Services","0","8 K"\r\n"chrome.exe","123","Console","1","200,000 K"\r\n"helldivers2.exe","4567","Console","1","4,000,000 K"\r\n';
    expect(parseTasklist(tasklist)).toEqual(['system idle process', 'chrome.exe', 'helldivers2.exe']);
    expect(matchKnownGame(parseTasklist(tasklist))).toBe('Helldivers 2');
    expect(matchKnownGame(['chrome.exe', 'my-secret-tool.exe', 'notepad.exe'])).toBeNull();
  });

  it('publishes nothing when disabled, and never a hidden game', () => {
    const prefs = { showGameActivity: true, hiddenGames: ['Helldivers 2'] };
    expect(publicGameName('Elden Ring', prefs)).toBe('Elden Ring');
    expect(publicGameName('helldivers 2', prefs)).toBeNull();
    expect(publicGameName('Elden Ring', { ...prefs, showGameActivity: false })).toBeNull();
    expect(publicGameName(null, prefs)).toBeNull();
  });
});

describe('overlay placement and settings', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 } };
  const second = { id: 2, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, workArea: { x: 2560, y: 0, width: 1920, height: 1040 } };
  const size = { width: 320, height: 460 };

  it('places it in a corner of the chosen display, falling back to the primary one', () => {
    expect(computeOverlayBounds({ corner: 'top-left', displayId: null, custom: null }, size, [primary, second], primary)).toEqual({ x: 16, y: 16, ...size });
    expect(computeOverlayBounds({ corner: 'bottom-right', displayId: 2, custom: null }, size, [primary, second], primary)).toEqual({
      x: 2560 + 1920 - 320 - 16,
      y: 1040 - 460 - 16,
      ...size,
    });
    // Display unplugged -> primary.
    expect(computeOverlayBounds({ corner: 'top-right', displayId: 9, custom: null }, size, [primary], primary).x).toBe(2560 - 320 - 16);
  });

  it('keeps a dragged position on its display, inside the work area', () => {
    expect(computeOverlayBounds({ corner: 'top-left', displayId: null, custom: { displayId: 2, x: 100, y: 50 } }, size, [primary, second], primary)).toEqual({ x: 2660, y: 50, ...size });
    expect(computeOverlayBounds({ corner: 'top-left', displayId: null, custom: { displayId: 2, x: 5000, y: 5000 } }, size, [primary, second], primary)).toEqual({
      x: 2560 + 1920 - 320,
      y: 1040 - 460,
      ...size,
    });
    // Its display is gone -> back to the corner on the primary display.
    expect(computeOverlayBounds({ corner: 'top-left', displayId: null, custom: { displayId: 2, x: 100, y: 50 } }, size, [primary], primary)).toEqual({ x: 16, y: 16, ...size });
  });

  it('sanitizes overlay settings (ranges and choices)', () => {
    const s = sanitizeOverlay({ scale: 400, opacity: 1, messageCount: 7, messageSeconds: 5, corner: 'middle', mode: 'huge', custom: { displayId: 'x' } });
    expect(s).toMatchObject({ scale: 150, opacity: 20, messageCount: DEFAULT_OVERLAY.messageCount, messageSeconds: 5, corner: 'top-left', mode: 'extended', custom: null });
    const patched = applySettingsPatch(DEFAULT_DESKTOP_SETTINGS, { overlay: { enabled: false } });
    expect(patched.ok && patched.settings.overlay.enabled).toBe(false);
    expect(DEFAULT_DESKTOP_SETTINGS.keybinds.toggleOverlay).toBe('Ctrl+Shift+O');
  });

  it('validates what the main window sends to the overlay', () => {
    const state = sanitizeOverlayState({
      inCall: true,
      channelName: 'General',
      micEnabled: false,
      deafened: true,
      participants: [{ id: 'u1', name: 'Valentine', avatar: 'javascript:alert(1)', color: '#123', initials: 'V', speaking: true, micMuted: false, deafened: false, isSelf: true }, { name: 'no id' }],
    });
    expect(state?.participants).toHaveLength(1);
    expect(state?.participants[0]).toMatchObject({ id: 'u1', avatar: null, speaking: true });
    expect(sanitizeOverlayState({ participants: 'x' })).toBeNull();
    expect(sanitizeOverlayMessage({ id: 'm1', text: 'x'.repeat(1000), authorName: 'A' })?.text).toHaveLength(300);
  });
});

describe('overlay v2 (0.4.0)', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 } };
  const chatSize = { width: 340, height: 300 };

  it('puts the message panel under the list (above it for bottom corners), or where it was dragged', () => {
    const list = { x: 16, y: 16, width: 300, height: 420 };
    expect(computeChatBounds({ corner: 'top-left', chatCustom: null }, chatSize, list, [primary], primary)).toEqual({ x: 16, y: 16 + 420 + 8, ...chatSize });
    const bottom = { x: 2560 - 300 - 16, y: 1400 - 420 - 16, width: 300, height: 420 };
    expect(computeChatBounds({ corner: 'bottom-right', chatCustom: null }, chatSize, bottom, [primary], primary)).toEqual({
      x: 2560 - 16 - 340,
      y: 1400 - 420 - 16 - 300 - 8,
      ...chatSize,
    });
    expect(computeChatBounds({ corner: 'top-left', chatCustom: { displayId: 1, x: 900, y: 500 } }, chatSize, list, [primary], primary)).toEqual({ x: 900, y: 500, ...chatSize });
  });

  it('quick replies only go to channels / messages the overlay actually showed', () => {
    const shown = [sanitizeOverlayMessage({ id: '11111111-1111-4111-8111-111111111111', text: 'hi', channelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channelLabel: '#general', mention: true })];
    expect(shown[0]).toMatchObject({ channelLabel: '#general', mention: true });
    const ok = shown.flatMap((m) => (m ? [m] : []));
    expect(sanitizeOverlayReply({ channelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', replyToId: '11111111-1111-4111-8111-111111111111', text: '  ok  ' }, ok)).toEqual({
      channelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      replyToId: '11111111-1111-4111-8111-111111111111',
      text: 'ok',
    });
    expect(sanitizeOverlayReply({ channelId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: 'x' }, ok)).toBeNull();
    expect(sanitizeOverlayReply({ channelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: '   ' }, ok)).toBeNull();
    expect(sanitizeOverlayReply({ channelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', replyToId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', text: 'x' }, ok)?.replyToId).toBeNull();
    expect(sanitizeOverlayReply({ channelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'x'.repeat(5000) }, ok)?.text).toHaveLength(2000);
  });

  it('keeps the streaming flag of participants', () => {
    expect(sanitizeOverlayState({ inCall: true, participants: [{ id: 'u1', name: 'A', streaming: true }] })?.participants[0]?.streaming).toBe(true);
  });
});
