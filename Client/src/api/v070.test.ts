import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthHandlers, setTokenStore, storeTokens } from './client';
import { MemoryTokenStore } from './tokenStorage';
import { jsonResponse, tokenPair } from '../test/fixtures';
import { guildsApi } from './guilds';
import { getLanguage } from '../i18n';
import { channelsApi } from './channels';
import { invitesApi, normalizeInviteInput } from './invites';
import { friendsApi } from './friends';
import { messagesApi } from './messages';
import { voiceApi } from './voice';
import { limitsApi } from './limits';

const fetchMock = vi.fn<typeof fetch>();

/** The method, path (with query) and JSON body of one recorded call. */
function call(i = 0): { method: string; path: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[i] ?? [];
  const u = new URL(String(url), 'http://x');
  const raw = init?.body;
  return { method: init?.method ?? 'GET', path: `${u.pathname}${u.search}`, body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined };
}

describe('0.7.0 API modules', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    setTokenStore(new MemoryTokenStore());
    setAuthHandlers({ onAuthFailure: () => undefined });
    storeTokens(tokenPair(1), true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates and deletes a server', async () => {
    await guildsApi.create('Мой сервер');
    expect(call(0)).toEqual({ method: 'POST', path: '/api/v1/guilds', body: { name: 'Мой сервер', lang: getLanguage() } });
    await guildsApi.remove('g1', 'Мой сервер');
    expect(call(1)).toEqual({ method: 'DELETE', path: '/api/v1/guilds/g1', body: { confirmName: 'Мой сервер' } });
  });

  it('reorders channels with items and asks for channel permissions', async () => {
    await guildsApi.reorderChannels('g1', [{ id: 'c1', parentId: null, position: 0 }]);
    expect(call(0)).toEqual({ method: 'PUT', path: '/api/v1/guilds/g1/channels/order', body: { items: [{ id: 'c1', parentId: null, position: 0 }] } });
    await guildsApi.permissions('g1', 'c1');
    expect(call(1).path).toBe('/api/v1/guilds/g1/permissions?channelId=c1');
  });

  it('sets and removes channel overwrites', async () => {
    await channelsApi.setOverwrite('c1', 'ROLE', 'r1', { allow: ['VIEW_CHANNEL'], deny: [] });
    expect(call(0)).toEqual({ method: 'PUT', path: '/api/v1/channels/c1/overwrites/ROLE/r1', body: { allow: ['VIEW_CHANNEL'], deny: [] } });
    await channelsApi.removeOverwrite('c1', 'MEMBER', 'u1');
    expect(call(1)).toMatchObject({ method: 'DELETE', path: '/api/v1/channels/c1/overwrites/MEMBER/u1' });
  });

  it('accepts invites, sends friend requests, searches DMs, server-mutes', async () => {
    await invitesApi.accept('abcd2345');
    expect(call(0)).toMatchObject({ method: 'POST', path: '/api/v1/invites/abcd2345/accept' });
    await friendsApi.request('bob');
    expect(call(1)).toEqual({ method: 'POST', path: '/api/v1/friends/requests', body: { username: 'bob' } });
    await messagesApi.search({ dms: true, q: 'привет' });
    expect(call(2).path).toBe(`/api/v1/search/messages?dms=1&q=${encodeURIComponent('привет')}`);
    await voiceApi.serverMute('v1', 'u1', true);
    expect(call(3)).toEqual({ method: 'PUT', path: '/api/v1/voice/channels/v1/participants/u1/server-mute', body: { muted: true } });
  });

  it('talks to the superadmin limits endpoint', async () => {
    await limitsApi.setOverride({ key: 'guilds.owned', scope: 'USER', targetId: 'u1', value: null });
    expect(call(0)).toEqual({ method: 'PUT', path: '/api/v1/admin/limits/overrides', body: { key: 'guilds.owned', scope: 'USER', targetId: 'u1', value: null } });
  });

  it('reads an invite code from a code or a link', () => {
    expect(normalizeInviteInput('https://chat.example.com/invite/AbCd2345')).toBe('abcd2345');
    expect(normalizeInviteInput('  ABCD2345 ')).toBe('abcd2345');
    expect(normalizeInviteInput('nope')).toBeNull();
    expect(normalizeInviteInput('abcd234!')).toBeNull();
  });
});

describe('0.7.0 friendly limit errors', () => {
  it('names the limit and its value', async () => {
    const { ApiError, friendlyError } = await import('./errors');
    const { i18next } = await import('../i18n');
    await i18next.changeLanguage('en');
    expect(friendlyError(new ApiError('http', 400, 'LIMIT_REACHED', 'raw', { key: 'guild.channels', limit: 50 }))).toBe('Limit reached for channels on the server: 50.');
    expect(friendlyError(new ApiError('http', 400, 'LIMIT_REACHED', 'raw', { key: 'unknown.key', limit: 5 }))).toBe('A limit was reached. Ask the administrator.');
  });
});
