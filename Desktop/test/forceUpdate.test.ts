import { describe, expect, it, vi } from 'vitest';
import { fetchMinimumVersion, shouldForceUpdate } from '../src/main/forceUpdate';

describe('0.7.0 forced update', () => {
  it('forces the update only when this version is below the server minimum', () => {
    expect(shouldForceUpdate('0.6.1', '0.7.0')).toBe(true);
    expect(shouldForceUpdate('0.7.0', '0.7.0')).toBe(false);
    expect(shouldForceUpdate('0.7.1', '0.7.0')).toBe(false);
    expect(shouldForceUpdate('0.10.0', '0.9.9')).toBe(false);
    expect(shouldForceUpdate('0.6.1', null)).toBe(false);
    expect(shouldForceUpdate('0.6.1', 'garbage')).toBe(false);
  });

  it('reads minimumVersion from /api/v1/client/version and tolerates failures', async () => {
    const ok = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ latestVersion: '0.7.0', minimumVersion: '0.7.0' }), { status: 200 })));
    expect(await fetchMinimumVersion('https://example.test', ok)).toBe('0.7.0');
    expect(ok).toHaveBeenCalledWith('https://example.test/api/v1/client/version', expect.anything());
    expect(await fetchMinimumVersion('https://example.test', () => Promise.resolve(new Response('nope', { status: 500 })))).toBeNull();
    expect(await fetchMinimumVersion('https://example.test', () => Promise.reject(new Error('offline')))).toBeNull();
  });
});
