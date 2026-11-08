import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, login, TEST_PASSWORD, type TestEnv } from './helpers.js';

describe('authentication', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alex', 'ADMIN');
    await createUser(env, 'Bob');
    const disabled = await createUser(env, 'Dora');
    await env.users.setDisabled(disabled.id, true);
  });

  afterAll(async () => {
    await env.close();
  });

  it('logs in with valid credentials and never exposes the password hash', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'alex', password: TEST_PASSWORD, clientType: 'web' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ tokenType: 'Bearer', user: { username: 'Alex', role: 'ADMIN' } });
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(res.body).not.toContain('passwordHash');
    expect(res.body).not.toContain('$argon2');
  });

  it('stores Argon2id password hashes', async () => {
    const user = await env.prisma.user.findUniqueOrThrow({ where: { usernameNormalized: 'alex' } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects a wrong password and an unknown user with the same error', async () => {
    const wrong = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'Alex', password: 'wrong-password' },
    });
    const unknown = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nobody', password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } });
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('does not let a disabled account log in', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'Dora', password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'ACCOUNT_DISABLED' } });
  });

  it('validates login input', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'Alex' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('protects endpoints that require authentication', async () => {
    const noToken = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    const badToken = await env.app.inject({ method: 'GET', url: '/api/v1/guilds', headers: bearer('not-a-jwt') });
    expect(badToken.statusCode).toBe(401);
  });

  it('has no public registration endpoint (0.7.1: /auth/register exists but is closed by default)', async () => {
    const closed = await env.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'eve', password: 'password123', displayName: 'Eve', email: 'eve@example.org' } });
    expect(closed.statusCode).toBe(403);
    expect(closed.json<{ error: { code: string } }>().error.code).toBe('REGISTRATION_CLOSED');
    expect(await env.prisma.user.count({ where: { usernameNormalized: 'eve' } })).toBe(0);
    for (const url of ['/api/v1/register', '/register', '/api/v1/users']) {
      const res = await env.app.inject({
        method: 'POST',
        url,
        payload: { username: 'eve', password: 'password123', displayName: 'Eve' },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('returns the current user from /auth/me', async () => {
    const session = await login(env, 'Bob');
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(session.accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: 'Bob', role: 'USER' }, sessionId: session.sessionId });
  });

  it('rotates refresh tokens and revokes the session when an old token is reused', async () => {
    const first = await login(env, 'Bob');

    const refreshed = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json<{ accessToken: string; refreshToken: string; sessionId: string }>();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.sessionId).toBe(first.sessionId);

    const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(second.accessToken) });
    expect(me.statusCode).toBe(200);

    // Re-using the rotated token is treated as theft: the whole session is revoked.
    const reuse = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ error: { code: 'REFRESH_TOKEN_REUSED' } });

    const afterReuse = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: second.refreshToken },
    });
    expect(afterReuse.statusCode).toBe(401);
    const meAfter = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(second.accessToken) });
    expect(meAfter.statusCode).toBe(401);
  });

  it('rejects malformed and unknown refresh tokens', async () => {
    for (const refreshToken of ['garbage-token-value', '00000000-0000-4000-8000-000000000000.abcdefghijk']) {
      const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
      expect(res.statusCode).toBe(401);
    }
  });

  it('logout revokes the current session only', async () => {
    const a = await login(env, 'Bob');
    const b = await login(env, 'Bob');
    const out = await env.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(a.accessToken) });
    expect(out.statusCode).toBe(204);

    const meA = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(a.accessToken) });
    expect(meA.statusCode).toBe(401);
    const refreshA = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: a.refreshToken },
    });
    expect(refreshA.statusCode).toBe(401);

    const meB = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(b.accessToken) });
    expect(meB.statusCode).toBe(200);
  });

  it('logout-all revokes every session of the user', async () => {
    const a = await login(env, 'Bob');
    const b = await login(env, 'Bob');
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: bearer(a.accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ revokedSessions: number }>().revokedSessions).toBeGreaterThanOrEqual(2);
    for (const s of [a, b]) {
      const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(s.accessToken) });
      expect(me.statusCode).toBe(401);
    }
  });

  it('lets a user list and revoke one of their devices', async () => {
    const phone = await login(env, 'Bob');
    const desktop = await login(env, 'Bob');
    const list = await env.app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: bearer(desktop.accessToken) });
    const sessions = list.json<{ sessions: { id: string; current: boolean }[] }>().sessions;
    expect(sessions.find((s) => s.id === desktop.sessionId)?.current).toBe(true);
    expect(sessions.some((s) => s.id === phone.sessionId)).toBe(true);

    const del = await env.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${phone.sessionId}`,
      headers: bearer(desktop.accessToken),
    });
    expect(del.statusCode).toBe(204);
    const mePhone = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(phone.accessToken) });
    expect(mePhone.statusCode).toBe(401);
  });

  it('disabling a user immediately invalidates their existing access token', async () => {
    const user = await createUser(env, 'Carl');
    const s = await login(env, 'Carl');
    await env.users.setDisabled(user.id, true);
    const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(s.accessToken) });
    expect(me.statusCode).toBe(401);
  });

  it('restricts admin endpoints to ADMIN', async () => {
    const bob = await login(env, 'Bob');
    const alex = await login(env, 'Alex');
    const asUser = await env.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(bob.accessToken) });
    expect(asUser.statusCode).toBe(403);
    const asAdmin = await env.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(alex.accessToken) });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.body).not.toContain('passwordHash');
  });

  it('lets users change their own password, revoking their sessions', async () => {
    await createUser(env, 'Eli');
    const s = await login(env, 'Eli');
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: bearer(s.accessToken),
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' },
    });
    expect(res.statusCode).toBe(204);
    const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(s.accessToken) });
    expect(me.statusCode).toBe(401);
    await expect(login(env, 'Eli', 'a-brand-new-password')).resolves.toMatchObject({ user: { username: 'Eli' } });
  });

  it('rate limits repeated failed logins for one username', async () => {
    await createUser(env, 'Fay');
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'Fay', password: 'wrong-password' },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});
