/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- inject().json() bodies are untyped; the assertions check their shape. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv } from './helpers.js';

type Env = Awaited<ReturnType<typeof createTestEnv>>;
const CODE = 'Kq7mPz3xWv9rTb2nHs8dLc4f';

const admin = (over: Record<string, unknown> = {}) => ({
  code: CODE,
  username: 'alice',
  displayName: 'Alice',
  password: 'alice-password-123',
  email: 'alice@example.com',
  guildName: 'Our place',
  registrationMode: 'invite',
  lang: 'en',
  ...over,
});

/** A fresh install: createTestEnv() makes a "test-owner" account, so remove every account first. */
async function emptyInstall(codeFile: string) {
  const env = await createTestEnv({ SETUP_CODE_FILE: codeFile });
  await env.prisma.guild.deleteMany({});
  await env.prisma.user.deleteMany({});
  return env;
}

describe('first-run wizard (server)', () => {
  let dir: string;
  let codeFile: string;
  let env: Env;
  const post = (body: Record<string, unknown>) => env.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: body });
  const status = async () => (await env.app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json<{ needed: boolean }>();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'aidis-setup-'));
    codeFile = path.join(dir, 'setup-code');
    await writeFile(codeFile, `${CODE}\n`);
    env = await emptyInstall(codeFile);
  });
  afterAll(async () => {
    await env.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is needed while there are no accounts', async () => {
    expect(await status()).toEqual({ needed: true });
  });

  it('refuses a wrong code and does not create anything', async () => {
    const res = await post(admin({ code: 'wrong-code-wrong-code-000' }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SETUP_CODE_INVALID');
    expect(await env.prisma.user.count()).toBe(0);
  });

  it('Review Focus 1: two browsers at once -> exactly one administrator', async () => {
    const [a, b] = await Promise.all([post(admin()), post(admin({ username: 'mallory', email: 'mallory@example.com' }))]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 403]);
    const loser = a.statusCode === 403 ? a : b;
    expect(loser.json().error.code).toBe('SETUP_DONE');
    expect(await env.prisma.user.count()).toBe(1);

    const winner = a.statusCode === 200 ? a : b;
    const body = winner.json();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.user.role).toBe('ADMIN');
    expect(body.inviteCode).toMatch(/^[a-z0-9]{6,16}$/);
    const guild = await env.prisma.guild.findUniqueOrThrow({ where: { id: body.guildId } });
    expect(guild.name).toBe('Our place');
    expect(guild.ownerId).toBe(body.user.id);
    // The wizard ran in English: the first server's channels are named in English.
    expect((await env.prisma.channel.findFirstOrThrow({ where: { guildId: body.guildId, type: 'TEXT' } })).name).toBe('general');
    const invite = await env.prisma.invite.findUniqueOrThrow({ where: { code: body.inviteCode } });
    expect(invite).toMatchObject({ guildId: body.guildId, expiresAt: null, maxUses: null });
    const user = await env.prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(user.email).toBe(body.user.username === 'alice' ? 'alice@example.com' : 'mallory@example.com');
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('is closed afterwards, even with the right code', async () => {
    expect(await status()).toEqual({ needed: false });
    const again = await post(admin({ username: 'bob', email: 'bob@example.com' }));
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('SETUP_DONE');
  });

  it('remembers the chosen registration mode (it takes effect once mail is checked)', async () => {
    const stored = await env.prisma.appSetting.findUniqueOrThrow({ where: { key: 'registration' } });
    expect(stored.value).toEqual({ mode: 'invite' });
  });
});

describe('first-run wizard without a code file', () => {
  it('stays closed', async () => {
    const env = await emptyInstall(path.join(os.tmpdir(), 'aidis-no-such-dir', 'setup-code'));
    try {
      const res = await env.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: admin() });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SETUP_CODE_INVALID');
      expect(await env.prisma.user.count()).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('validates the form', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aidis-setup-'));
    const file = path.join(dir, 'setup-code');
    await writeFile(file, CODE);
    const env = await emptyInstall(file);
    try {
      for (const bad of [admin({ password: 'short' }), admin({ username: 'a' }), admin({ guildName: '' }), admin({ registrationMode: 'everyone' })]) {
        expect((await env.app.inject({ method: 'POST', url: '/api/v1/setup/complete', payload: bad })).statusCode).toBe(400);
      }
      expect(await env.prisma.user.count()).toBe(0);
    } finally {
      await env.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
