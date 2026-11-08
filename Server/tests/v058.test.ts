import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, login, type LoginResult, type TestEnv } from './helpers.js';

describe('0.5.8 server', () => {
  let env: TestEnv;
  let admin: LoginResult;
  let bob: LoginResult;
  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'admin', 'ADMIN');
    await createUser(env, 'bob');
    admin = await login(env, 'admin');
    bob = await login(env, 'bob');
  });
  afterAll(async () => {
    await env.close();
  });

  const get = (token: string, url: string) => env.app.inject({ method: 'GET', url, headers: bearer(token) });

  describe('admin panel', () => {
    it('reports the system to admins only', async () => {
      const res = await get(admin.accessToken, '/api/v1/admin/overview');
      expect(res.statusCode).toBe(200);
      const body = res.json<{ server: { version: string; uptimeSeconds: number }; database: { ok: boolean }; counts: { users: number } }>();
      expect(body.database.ok).toBe(true);
      // admin, bob and the test server's owner
      expect(body.counts.users).toBe(3);
      expect((await get(bob.accessToken, '/api/v1/admin/overview')).statusCode).toBe(403);
      expect((await get(admin.accessToken, '/api/v1/admin/connections')).json()).toEqual({ connections: [] });
      const storage = await get(admin.accessToken, '/api/v1/admin/storage');
      expect(storage.json<{ files: { count: number }; partial: { count: number } }>()).toMatchObject({ files: { count: 0 }, partial: { count: 0 } });
    });

    it('keeps an announcement for everyone and audits admin account actions', async () => {
      const put = await env.app.inject({ method: 'PUT', url: '/api/v1/admin/announcement', headers: bearer(admin.accessToken), payload: { text: '  Restart at 23:00  ', level: 'warning' } });
      expect(put.statusCode).toBe(200);
      const seen = await get(bob.accessToken, '/api/v1/announcement');
      expect(seen.json<{ announcement: { text: string; level: string } }>().announcement).toMatchObject({ text: 'Restart at 23:00', level: 'warning' });
      expect((await env.app.inject({ method: 'PUT', url: '/api/v1/admin/announcement', headers: bearer(bob.accessToken), payload: { text: 'x' } })).statusCode).toBe(403);
      expect((await env.app.inject({ method: 'DELETE', url: '/api/v1/admin/announcement', headers: bearer(admin.accessToken) })).statusCode).toBe(204);
      expect((await get(bob.accessToken, '/api/v1/announcement')).json()).toEqual({ announcement: null });

      const created = await env.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(admin.accessToken), payload: { username: 'carol', displayName: 'Carol', password: 'carol-password-123' } });
      expect(created.statusCode).toBe(201);
      const audit = await get(admin.accessToken, '/api/v1/admin/audit');
      const actions = audit.json<{ entries: { action: string }[] }>().entries.map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['user.created', 'announcement.set', 'announcement.cleared']));
    });
  });
});
