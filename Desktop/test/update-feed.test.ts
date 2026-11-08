import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '1.0.0', getPath: () => 'C:/tmp' } }));

const { updateFeed, GITHUB_RELEASES } = await import('../src/main/updater');

describe('where the desktop app looks for updates', () => {
  it('GitHub Releases of the repository from desktop.config.json', () => {
    expect(GITHUB_RELEASES).toEqual({ owner: 'example', repo: 'AIDis' });
    expect(updateFeed({ owner: 'example', repo: 'AIDis' }, null)).toEqual({ provider: 'github', owner: 'example', repo: 'AIDis' });
  });

  it('the mirror of the current server wins, https only', () => {
    expect(updateFeed({ owner: 'example', repo: 'AIDis' }, 'https://chat.example.com/updates/')).toEqual({ provider: 'generic', url: 'https://chat.example.com/updates/' });
    expect(updateFeed({ owner: 'example', repo: 'AIDis' }, 'http://chat.example.com/updates/')).toEqual({ provider: 'github', owner: 'example', repo: 'AIDis' });
  });

  it('placeholders mean "no updates" rather than asking a wrong repository', () => {
    expect(updateFeed({ owner: 'OWNER', repo: 'AIDis' }, null)).toBeNull();
    expect(updateFeed({ owner: '', repo: '' }, null)).toBeNull();
  });
});
