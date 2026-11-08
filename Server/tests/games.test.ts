/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- inject().json() bodies are untyped; the assertions check their shape. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, login } from './helpers.js';

type Env = Awaited<ReturnType<typeof createTestEnv>>;
type Login = Awaited<ReturnType<typeof login>>;

describe('game tracker', () => {
  let env: Env;
  let alice: Login;
  let bob: Login;
  let stranger: Login;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    await createUser(env, 'Stranger', 'USER', { join: false });
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    stranger = await login(env, 'Stranger');
  });
  afterAll(async () => {
    await env.close();
  });

  const api = (who: Login, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    env.app.inject({ method, url: `/api/v1${url}`, headers: bearer(who.accessToken), ...(payload ? { payload } : {}) });
  const list = async (who: Login, of: Login) =>
    (await api(who, 'GET', `/users/${of.user.id}/games`)).json().games as { id: string; name: string; status: string; platform: string; manual: boolean; totalSeconds: number }[];

  let hades = '';
  it('adds games by hand from any platform and edits them', async () => {
    const res = await api(alice, 'POST', '/users/me/games', { name: 'Hades', platform: 'PLAYSTATION', status: 'PLAYING' });
    expect(res.statusCode).toBe(201);
    hades = res.json().game.id;
    expect(res.json().game).toMatchObject({ name: 'Hades', platform: 'PLAYSTATION', status: 'PLAYING', manual: true, totalSeconds: 0 });
    expect((await api(alice, 'POST', '/users/me/games', { name: 'HADES', platform: 'PC', status: 'PLAYING' })).json().error.code).toBe('GAME_EXISTS');
    expect((await api(alice, 'POST', '/users/me/games', { name: 'Zelda', platform: 'GAMECUBE', status: 'PLAYING' })).statusCode).toBe(400);

    const zelda = (await api(alice, 'POST', '/users/me/games', { name: 'Zelda', platform: 'SWITCH', status: 'COMPLETED' })).json().game.id;
    const patched = await api(alice, 'PATCH', `/users/me/games/${zelda}`, { status: 'HUNDRED' });
    expect(patched.json().game).toMatchObject({ name: 'Zelda', status: 'HUNDRED' });
    expect((await api(bob, 'PATCH', `/users/me/games/${zelda}`, { status: 'DROPPED' })).statusCode).toBe(404);
    expect((await api(alice, 'DELETE', `/users/me/games/${zelda}`)).statusCode).toBe(204);
    expect((await list(alice, alice)).map((g) => g.name)).toEqual(['Hades']);
  });

  it('Review Focus 4: a hand-added game later launched on the PC stays one entry', async () => {
    const started = new Date(Date.now() - 30 * 60_000).toISOString();
    env.ctx.services.games.started(alice.user.id, { type: 'playing', name: 'HADES', steamAppId: null, startedAt: started });
    env.ctx.services.games.ended(alice.user.id, { type: 'playing', name: 'HADES', steamAppId: null, startedAt: started });
    await new Promise((r) => setTimeout(r, 100));
    const games = await list(alice, alice);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ id: hades, name: 'Hades', platform: 'PLAYSTATION', status: 'PLAYING', manual: true });
    expect(games[0]?.totalSeconds).toBeGreaterThanOrEqual(29 * 60);
  });

  it('a game played on the PC appears by itself', async () => {
    env.ctx.services.games.started(bob.user.id, { type: 'playing', name: 'Celeste', steamAppId: 504230, startedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 100));
    expect(await list(bob, bob)).toEqual([expect.objectContaining({ name: 'Celeste', platform: 'PC', status: 'PLAYING', manual: false })]);
  });

  it('asks "how did it end?" after 14 days without launching, once per break', async () => {
    const prompts = async () => (await api(bob, 'GET', '/users/me/games/prompts')).json().games as { id: string }[];
    expect(await prompts()).toEqual([]);
    await env.prisma.userGame.updateMany({ where: { userId: bob.user.id }, data: { lastPlayedAt: new Date(Date.now() - 15 * 86_400_000) } });
    const due = await prompts();
    expect(due).toHaveLength(1);
    expect((await api(bob, 'POST', `/users/me/games/${due[0]?.id}/prompted`)).statusCode).toBe(204);
    expect(await prompts()).toEqual([]);
    // Played again (after the prompt) and forgotten again -> asked again.
    await env.prisma.userGame.updateMany({ where: { userId: bob.user.id }, data: { lastPlayedAt: new Date(Date.now() - 14.5 * 86_400_000), promptedAt: new Date(Date.now() - 20 * 86_400_000) } });
    expect(await prompts()).toHaveLength(1);
    // Finished games are never asked about.
    await api(bob, 'PATCH', `/users/me/games/${due[0]?.id}`, { status: 'COMPLETED' });
    expect(await prompts()).toEqual([]);
  });

  it('others see the shelf only like the profile; a hidden shelf is empty', async () => {
    expect((await list(bob, alice)).map((g) => g.name)).toEqual(['Hades']);
    expect((await api(stranger, 'GET', `/users/${alice.user.id}/games`)).statusCode).toBe(404);
    await env.app.inject({ method: 'PATCH', url: '/api/v1/users/me', headers: bearer(alice.accessToken), payload: { showRecentGames: false } });
    const hidden = (await api(bob, 'GET', `/users/${alice.user.id}/games`)).json();
    expect(hidden).toEqual({ games: [], hidden: true });
    expect((await list(alice, alice)).map((g) => g.name)).toEqual(['Hades']);
  });

  it('a cover must be an image the player uploaded', async () => {
    const other = await env.prisma.attachment.create({
      data: { uploaderId: bob.user.id, storedName: 'cover-of-bob.png', originalName: 'c.png', mimeType: 'image/png', size: 10, sha256: '0'.repeat(64) },
    });
    expect((await api(alice, 'PATCH', `/users/me/games/${hades}`, { coverAttachmentId: other.id })).statusCode).toBe(400);
  });
});
