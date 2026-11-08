/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- inject().json() bodies are untyped; the assertions check their shape. */
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, createUser, login } from './helpers.js';

type Env = Awaited<ReturnType<typeof createTestEnv>>;
type Login = Awaited<ReturnType<typeof login>>;

const settings = (over: Record<string, unknown> = {}) => ({
  host: 'smtp.example.com',
  port: 587,
  security: 'starttls',
  username: 'robot@example.com',
  password: 'smtp-super-secret-password',
  fromName: 'AIDis',
  fromAddress: 'robot@example.com',
  ...over,
});

describe('0.7.1 mail (SMTP settings)', () => {
  let env: Env;
  let root: Login;
  let bob: Login;
  const sent: { from: string; to: string; subject: string; text: string; html: string }[] = [];
  let fail = false;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Root', 'ADMIN');
    await createUser(env, 'Bob');
    root = await login(env, 'Root');
    bob = await login(env, 'Bob');
    env.ctx.services.mail.setTransportFactory(() => {
      const json = nodemailer.createTransport({ jsonTransport: true });
      return {
        sendMail: async (message) => {
          if (fail) throw new Error('535 authentication failed');
          const info = await json.sendMail(message);
          sent.push(JSON.parse((info as unknown as { message: string }).message));
          return info;
        },
      };
    });
  });
  afterAll(async () => {
    await env.close();
  });

  const get = (token = root.accessToken) => env.app.inject({ method: 'GET', url: '/api/v1/admin/mail', headers: bearer(token) });
  const put = (body: Record<string, unknown>, token = root.accessToken) => env.app.inject({ method: 'PUT', url: '/api/v1/admin/mail', headers: bearer(token), payload: body });
  const test = (to: string) => env.app.inject({ method: 'POST', url: '/api/v1/admin/mail/test', headers: bearer(root.accessToken), payload: { to } });

  it('is for the superadmin only and starts empty', async () => {
    expect((await get(bob.accessToken)).statusCode).toBe(403);
    expect((await put(settings(), bob.accessToken)).statusCode).toBe(403);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().mail).toBeNull();
    expect(await env.ctx.services.mail.configured()).toBe(false);
  });

  it('stores the password sealed and never returns it', async () => {
    const res = await put(settings());
    expect(res.statusCode).toBe(200);
    expect(res.json().mail).toMatchObject({ host: 'smtp.example.com', port: 587, security: 'starttls', username: 'robot@example.com', hasPassword: true, fromAddress: 'robot@example.com', verifiedAt: null });
    expect(JSON.stringify(res.json())).not.toContain('smtp-super-secret-password');
    expect(JSON.stringify((await get()).json())).not.toContain('smtp-super-secret-password');
    const row = await env.prisma.appSetting.findUniqueOrThrow({ where: { key: 'mail' } });
    expect(JSON.stringify(row.value)).not.toContain('smtp-super-secret-password');
    // Saving without a password keeps the stored one.
    const again = await put(settings({ password: undefined, fromName: 'AIDis robot' }));
    expect(again.json().mail).toMatchObject({ hasPassword: true, fromName: 'AIDis robot' });
  });

  it('rejects broken settings', async () => {
    for (const bad of [settings({ host: '' }), settings({ port: 0 }), settings({ security: 'ssl' }), settings({ fromAddress: 'not-an-email' })]) {
      expect((await put(bad)).statusCode).toBe(400);
    }
  });

  it('sends a test letter from the configured address and marks the settings verified', async () => {
    const res = await test('admin@example.org');
    expect(res.statusCode).toBe(200);
    expect(res.json().mail.verifiedAt).toEqual(expect.any(String));
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.from)).toContain('robot@example.com');
    expect(JSON.stringify(sent[0]?.to)).toContain('admin@example.org');
    expect(sent[0]?.subject).toContain('AIDis');
    expect(await env.ctx.services.mail.configured()).toBe(true);
  });

  it('a transport error is 502 MAIL_FAILED and the settings stay unverified after a change', async () => {
    // Changing only the display name keeps the check.
    expect((await put(settings({ password: undefined, fromName: 'AIDis' }))).json().mail.verifiedAt).toEqual(expect.any(String));
    // Changing the host resets it.
    const changed = await put(settings({ password: undefined, host: 'smtp2.example.com' }));
    expect(changed.json().mail.verifiedAt).toBeNull();
    expect(await env.ctx.services.mail.configured()).toBe(false);

    fail = true;
    const res = await test('admin@example.org');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('MAIL_FAILED');
    expect(JSON.stringify(res.json())).not.toContain('smtp-super-secret-password');
    expect((await get()).json().mail.verifiedAt).toBeNull();
    fail = false;
  });

  it('builds letters in both languages with the link', async () => {
    await test('admin@example.org');
    sent.length = 0;
    await env.ctx.services.mail.send('user@example.org', { kind: 'reset', link: 'https://aidis.test/reset-password?token=abc', username: 'bob' }, 'ru');
    await env.ctx.services.mail.send('user@example.org', { kind: 'verify', link: 'https://aidis.test/verify?token=xyz', username: 'bob' }, 'en');
    expect(sent[0]?.text).toContain('https://aidis.test/reset-password?token=abc');
    expect(sent[0]?.subject).toMatch(/[а-я]/i);
    expect(sent[1]?.html).toContain('https://aidis.test/verify?token=xyz');
    expect(sent[1]?.subject).toMatch(/confirm/i);
  });
});
