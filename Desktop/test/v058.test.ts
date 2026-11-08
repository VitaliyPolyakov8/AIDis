import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.5.8' },
  BrowserWindow: vi.fn(),
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
  screen: { on: vi.fn(), off: vi.fn() },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { normalizeGameName, parseAppManifestName } = await import('../src/main/gameDetector');

describe('0.5.8 Steam id by name', () => {
  it('matches installed Steam games by name, ignoring case, marks and punctuation', () => {
    expect(normalizeGameName('ENSHROUDED™')).toBe(normalizeGameName('Enshrouded'));
    expect(normalizeGameName('Hades: Battle Out of Hell')).toBe('hades battle out of hell');
    expect(parseAppManifestName('"AppState"\n{\n\t"appid"\t\t"1203220"\n\t"name"\t\t"Enshrouded"\n}')).toBe('Enshrouded');
  });
});
