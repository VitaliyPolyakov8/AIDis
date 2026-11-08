import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSocket, createTestEnv, createUser, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';
import { PLATFORM_GRACE_MS } from '../src/presence/presence.service.js';

interface Presence {
  userId: string;
  state: string;
  platforms: string[];
}

describe('0.5.1 profile cosmetics, platforms and version', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    [alice, bob] = await Promise.all([login(env, 'Alice'), login(env, 'Bob')]);
    baseUrl = await listen(env);
  });
  afterAll(async () => {
    await env.close();
  });

  const patchMe = (session: LoginResult, payload: unknown) =>
    env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: { authorization: `Bearer ${session.accessToken}` }, payload: payload as Record<string, unknown> });

  it('reports the API version', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ version: string }>().version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('stores built-in banner / frame ids only, broadcasts them and resets to none', async () => {
    const bobSocket = connectSocket(baseUrl, bob.accessToken);
    await waitForEvent(bobSocket, 'ready');
    const updated = waitForEvent<{ id: string; profileBannerId: string | null; avatarFrameId: string | null }>(bobSocket, 'user.updated');
    const ok = await patchMe(alice, { profileBannerId: 'aurora', avatarFrameId: 'neon_pulse' });
    expect(ok.statusCode).toBe(200);
    expect(await updated).toMatchObject({ id: alice.user.id, profileBannerId: 'aurora', avatarFrameId: 'neon_pulse' });
    for (const bad of [{ profileBannerId: '../../etc/passwd' }, { profileBannerId: 'https://evil/x.gif' }, { avatarFrameId: '<style>' }, { avatarFrameId: 'not_a_frame' }]) {
      expect((await patchMe(alice, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${alice.accessToken}` } });
    expect(JSON.stringify(me.json())).toContain('"profileBannerId":"aurora"');
    const reset = await patchMe(alice, { profileBannerId: null, avatarFrameId: null });
    expect(reset.json<{ user: Record<string, unknown> }>().user).toMatchObject({ profileBannerId: null, avatarFrameId: null });
    bobSocket.close();
  });

  it('keeps a SET of active platforms per user and removes a closed one after the grace period', async () => {
    const watcher = connectSocket(baseUrl, bob.accessToken, { platform: 'web' });
    await waitForEvent(watcher, 'ready');
    const seen: Presence[] = [];
    watcher.on('presence.updated', (p: Presence) => {
      if (p.userId === alice.user.id) seen.push(p);
    });
    // 0.7.0: a desktop app must say its version (older ones are refused as outdated).
    const desktop = connectSocket(baseUrl, alice.accessToken, { platform: 'desktop', version: '0.7.0' });
    await waitForEvent(desktop, 'ready');
    const android = connectSocket(baseUrl, alice.accessToken, { platform: 'android' });
    await waitForEvent(android, 'ready');
    const web = connectSocket(baseUrl, alice.accessToken, { platform: 'something-else' });
    await waitForEvent(web, 'ready');
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.at(-1)?.platforms).toEqual(['desktop', 'web', 'android']);

    // Android closes: still listed during the grace period, then gone (desktop + web stay).
    android.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.at(-1)?.platforms).toEqual(['desktop', 'web', 'android']);
    await new Promise((r) => setTimeout(r, PLATFORM_GRACE_MS + 300));
    expect(seen.at(-1)?.platforms).toEqual(['desktop', 'web']);

    // A quick reconnect of the same kind does not flicker.
    const count = seen.length;
    web.close();
    const web2 = connectSocket(baseUrl, alice.accessToken, { platform: 'web' });
    await waitForEvent(web2, 'ready');
    await new Promise((r) => setTimeout(r, PLATFORM_GRACE_MS + 300));
    expect(seen.slice(count).every((p) => p.platforms.includes('web'))).toBe(true);

    // Fully offline: no platforms.
    const offline = new Promise<Presence>((resolve) => {
      watcher.on('presence.updated', (p: Presence) => {
        if (p.userId === alice.user.id && p.state === 'offline') resolve(p);
      });
    });
    desktop.close();
    web2.close();
    expect((await offline).platforms).toEqual([]);
    watcher.close();
  }, 30000);
});
