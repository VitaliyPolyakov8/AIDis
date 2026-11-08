/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- inject().json() bodies are untyped; the assertions check their shape. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, login, TEST_PASSWORD } from './helpers.js';

type Env = Awaited<ReturnType<typeof createTestEnv>>;
type Login = Awaited<ReturnType<typeof login>>;
interface Letter {
  to: string;
  subject: string;
  text: string;
}

/** The token from the last letter sent to `to` (links look like .../verify?token=XYZ). */
function tokenFrom(letters: Letter[], to: string): string {
  const letter = [...letters].reverse().find((l) => l.to === to);
  const match = letter ? /token=([A-Za-z0-9_-]+)/.exec(letter.text) : null;
  if (!match?.[1]) throw new Error(`no letter with a token for ${to}`);
  return match[1];
}

describe('0.7.1 registration, e-mail confirmation, password reset', () => {
  let env: Env;
  let root: Login;
  let owner: Login;
  const letters: Letter[] = [];
  let ip = 0;
  /** Every request from its own address unless a test wants the same one (throttles are per IP). */
  const nextIp = () => `10.0.0.${++ip}`;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Root', 'ADMIN');
    await createUser(env, 'Alice');
    root = await login(env, 'Root');
    owner = await login(env, 'test-owner');
    env.ctx.services.mail.setTransportFactory(() => ({
      sendMail: (m) => {
        letters.push({ to: m.to as string, subject: m.subject as string, text: m.text as string });
        return Promise.resolve({});
      },
    }));
  });
  afterAll(async () => {
    await env.close();
  });

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, token?: string, remoteAddress = nextIp()) =>
    env.app.inject({ method, url: `/api/v1${url}`, payload, remoteAddress, ...(token ? { headers: bearer(token) } : {}) });
  const register = (over: Record<string, unknown> = {}, remoteAddress?: string) =>
    call('POST', '/auth/register', { username: 'newbie', displayName: 'Newbie', email: 'newbie@example.org', password: 'newbie-password-123', lang: 'en', ...over }, undefined, remoteAddress);
  const setMode = (mode: string) => call('PUT', '/admin/registration', { mode }, root.accessToken);

  it('is off by default and cannot be turned on before mail is checked', async () => {
    expect((await call('GET', '/auth/registration')).json()).toEqual({ mode: 'off', mail: false });
    const res = await setMode('open');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MAIL_NOT_CONFIGURED');
    expect((await register()).statusCode).toBe(403);
    expect((await register()).json().error.code).toBe('REGISTRATION_CLOSED');

    await call('PUT', '/admin/mail', { host: 'smtp.example.com', port: 465, security: 'tls', username: 'robot', password: 'pw', fromName: 'AIDis', fromAddress: 'robot@example.com' }, root.accessToken);
    expect((await call('POST', '/admin/mail/test', { to: 'root@example.org' }, root.accessToken)).statusCode).toBe(200);
    expect((await setMode('invite')).statusCode).toBe(200);
    expect((await call('GET', '/auth/registration')).json()).toEqual({ mode: 'invite', mail: true });
    // Ordinary users cannot change it.
    const alice = await login(env, 'Alice');
    expect((await call('PUT', '/admin/registration', { mode: 'open' }, alice.accessToken)).statusCode).toBe(403);
  });

  let inviteCode = '';
  it('invite mode needs a working invite; then a confirmation letter is sent', async () => {
    const noCode = await register();
    expect(noCode.statusCode).toBe(403);
    expect(noCode.json().error.code).toBe('INVITE_REQUIRED');
    expect((await register({ inviteCode: 'nope-nope' })).json().error.code).toBe('INVITE_REQUIRED');

    const created = await call('POST', `/guilds/${env.guildId}/invites`, {}, owner.accessToken);
    inviteCode = created.json().invite.code;
    const before = letters.length;
    const res = await register({ inviteCode });
    expect(res.statusCode).toBe(202);
    expect(letters.length).toBe(before + 1);
    expect(letters.at(-1)?.to).toBe('newbie@example.org');
    expect(letters.at(-1)?.text).toContain('/verify?token=');
    // The invite page works without an account while registration is on.
    const pub = await call('GET', `/invites/${inviteCode}/public`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().invite.guild.name).toBe('AIDis');
  });

  it('Review Focus 3: names and e-mails in another case are taken; no login before confirmation', async () => {
    const name = await register({ username: 'ALICE', email: 'other@example.org', inviteCode });
    expect(name.statusCode).toBe(409);
    expect(name.json().error.code).toBe('USERNAME_TAKEN');
    await env.prisma.user.update({ where: { usernameNormalized: 'alice' }, data: { email: 'alice@example.org', emailVerifiedAt: new Date() } });
    const mail = await register({ username: 'alice2', email: 'Alice@Example.ORG', inviteCode });
    expect(mail.statusCode).toBe(409);
    expect(mail.json().error.code).toBe('EMAIL_TAKEN');

    const res = await call('POST', '/auth/login', { username: 'newbie', password: 'newbie-password-123' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    // A wrong password still says only "invalid credentials".
    expect((await call('POST', '/auth/login', { username: 'newbie', password: 'wrong-password-123' })).json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('confirming logs in and joins the server of the invite; the link works once', async () => {
    const token = tokenFrom(letters, 'newbie@example.org');
    const res = await call('POST', '/auth/verify-email', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.username).toBe('newbie');
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.guildId).toBe(env.guildId);
    const user = await env.prisma.user.findUniqueOrThrow({ where: { usernameNormalized: 'newbie' } });
    expect(user).toMatchObject({ email: 'newbie@example.org', pendingVerification: false });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await env.prisma.guildMember.count({ where: { guildId: env.guildId, userId: user.id } })).toBe(1);

    const again = await call('POST', '/auth/verify-email', { token });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('TOKEN_INVALID');
    expect((await call('POST', '/auth/login', { username: 'newbie', password: 'newbie-password-123' })).statusCode).toBe(200);
  });

  it('registering again with the e-mail of an unconfirmed account replaces it', async () => {
    await setMode('open');
    expect((await register({ username: 'ghost', email: 'ghost@example.org' })).statusCode).toBe(202);
    expect((await register({ username: 'ghost2', email: 'GHOST@example.org' })).statusCode).toBe(202);
    expect(await env.prisma.user.count({ where: { usernameNormalized: 'ghost' } })).toBe(0);
    expect(await env.prisma.user.count({ where: { email: 'ghost@example.org', pendingVerification: true } })).toBe(1);
  });

  it('throttles registrations from one address', async () => {
    const same = '10.9.9.9';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await register({ username: `spam${i}`, email: `spam${i}@example.org` }, same)).statusCode);
    expect(codes.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(codes[5]).toBe(429);
  });

  it('Review Focus 4: a reset link works once, expires, and signs out every session', async () => {
    const before = letters.length;
    expect((await call('POST', '/auth/password-reset', { email: 'nobody@example.org', lang: 'ru' })).statusCode).toBe(202);
    expect(letters.length).toBe(before);

    const session = await login(env, 'Alice');
    expect((await call('POST', '/auth/password-reset', { email: 'ALICE@example.org', lang: 'ru' })).statusCode).toBe(202);
    expect(letters.length).toBe(before + 1);
    expect(letters.at(-1)?.text).toContain('/reset-password?token=');
    const token = tokenFrom(letters, 'alice@example.org');

    const weak = await call('POST', '/auth/password-reset/confirm', { token, password: 'x' });
    expect(weak.statusCode).toBe(400);
    expect((await call('POST', '/auth/password-reset/confirm', { token, password: 'brand-new-password-1' })).statusCode).toBe(204);
    const reuse = await call('POST', '/auth/password-reset/confirm', { token, password: 'another-password-22' });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe('TOKEN_INVALID');
    expect((await call('POST', '/auth/refresh', { refreshToken: session.refreshToken })).statusCode).toBe(401);
    expect((await call('POST', '/auth/login', { username: 'Alice', password: TEST_PASSWORD })).statusCode).toBe(401);
    expect((await call('POST', '/auth/login', { username: 'Alice', password: 'brand-new-password-1' })).statusCode).toBe(200);

    // Expired link.
    await call('POST', '/auth/password-reset', { email: 'alice@example.org', lang: 'en' });
    const late = tokenFrom(letters, 'alice@example.org');
    await env.prisma.emailToken.updateMany({ where: { purpose: 'reset', usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await call('POST', '/auth/password-reset/confirm', { token: late, password: 'late-password-333' });
    expect(expired.json().error.code).toBe('TOKEN_INVALID');
  });

  it('limits reset letters per address', async () => {
    const statuses: number[] = [];
    const before = letters.length;
    for (let i = 0; i < 5; i++) statuses.push((await call('POST', '/auth/password-reset', { email: 'newbie@example.org', lang: 'en' })).statusCode);
    expect(statuses).toEqual([202, 202, 202, 202, 202]);
    expect(letters.length - before).toBe(3);
  });

  it('changes the e-mail after the new address is confirmed', async () => {
    const newbie = await login(env, 'newbie', 'newbie-password-123');
    expect((await call('GET', '/users/me/email', undefined, newbie.accessToken)).json()).toEqual({ email: 'newbie@example.org', verified: true });
    const taken = await call('PUT', '/users/me/email', { email: 'alice@example.org', lang: 'en' }, newbie.accessToken);
    expect(taken.json().error.code).toBe('EMAIL_TAKEN');
    expect((await call('PUT', '/users/me/email', { email: 'fresh@example.org', lang: 'en' }, newbie.accessToken)).statusCode).toBe(202);
    expect(letters.at(-1)?.to).toBe('fresh@example.org');
    const res = await call('POST', '/auth/verify-email', { token: tokenFrom(letters, 'fresh@example.org') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ emailChanged: true, email: 'fresh@example.org' });
    expect((await call('GET', '/users/me/email', undefined, newbie.accessToken)).json()).toEqual({ email: 'fresh@example.org', verified: true });
  });

  it('the superadmin can give an e-mail when creating an account; it is shown only to admins', async () => {
    const res = await call('POST', '/admin/users', { username: 'carol', displayName: 'Carol', password: 'carol-password-1', email: 'Carol@Example.org' }, root.accessToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: 'carol@example.org', pendingVerification: false });
    const dup = await call('POST', '/admin/users', { username: 'carol2', displayName: 'Carol', password: 'carol-password-1', email: 'carol@example.org' }, root.accessToken);
    expect(dup.json().error.code).toBe('EMAIL_TAKEN');
    const me = await call('GET', '/auth/me', undefined, owner.accessToken);
    expect(JSON.stringify(me.json())).not.toContain('@example');
  });

  it('turning off registration and the hourly cleanup', async () => {
    await env.prisma.user.updateMany({ where: { pendingVerification: true }, data: { createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
    await env.ctx.services.registration.cleanup();
    expect(await env.prisma.user.count({ where: { pendingVerification: true } })).toBe(0);
    expect(await env.prisma.emailToken.count({ where: { expiresAt: { lt: new Date() } } })).toBe(0);

    expect((await setMode('off')).statusCode).toBe(200);
    expect((await register({ username: 'late', email: 'late@example.org' })).json().error.code).toBe('REGISTRATION_CLOSED');
    expect((await call('GET', `/invites/${inviteCode}/public`)).statusCode).toBe(404);
  });
});
