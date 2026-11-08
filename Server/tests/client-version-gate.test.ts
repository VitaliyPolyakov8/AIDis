import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions } from '../src/client-version/client-version.js';
import { bearer, connectSocket, createTestEnv, createUser, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.7.0', '0.7.0')).toBe(0);
    expect(compareVersions('0.6.1', '0.7.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
  });
});

describe('mandatory update and admin-created accounts', () => {
  let env: TestEnv;
  let base: string;
  let dir: string;
  let alice: LoginResult, superadmin: LoginResult;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'aidis-version-'));
    const file = path.join(dir, 'client-version.json');
    await writeFile(file, JSON.stringify({ desktop: { latestVersion: '0.7.0', minimumVersion: '0.7.0', mandatory: true } }));
    env = await createTestEnv({ CLIENT_VERSION_FILE: file });
    await createUser(env, 'cvAlice');
    await createUser(env, 'cvSuper', 'ADMIN', { join: false });
    [alice, superadmin] = await Promise.all([login(env, 'cvAlice'), login(env, 'cvSuper')]);
    base = await listen(env);
  });
  afterAll(async () => {
    await env.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses an outdated desktop client with CLIENT_OUTDATED', async () => {
    const socket = connectSocket(base, alice.accessToken, { platform: 'desktop', version: '0.6.1' });
    try {
      const error = await waitForEvent<{ data?: { code: string } }>(socket, 'connect_error');
      expect(error.data?.code).toBe('CLIENT_OUTDATED');
    } finally {
      socket.disconnect();
    }
  });

  it('refuses a desktop client that sends no version', async () => {
    const socket = connectSocket(base, alice.accessToken, { platform: 'desktop' });
    try {
      expect((await waitForEvent<{ data?: { code: string } }>(socket, 'connect_error')).data?.code).toBe('CLIENT_OUTDATED');
    } finally {
      socket.disconnect();
    }
  });

  it('accepts a current desktop client and any web client', async () => {
    for (const auth of [{ platform: 'desktop', version: '0.7.0' }, { platform: 'web' }]) {
      const socket = connectSocket(base, alice.accessToken, auth);
      try {
        await waitForEvent(socket, 'ready');
      } finally {
        socket.disconnect();
      }
    }
  });

  it('lets the superadmin create an account that joins the chosen servers', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: bearer(superadmin.accessToken),
      payload: { username: 'cvNew', displayName: 'New', password: 'correct-horse-battery', guildIds: [env.guildId] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ user: { id: string } }>().user.id;
    expect(await env.ctx.services.permissions.isMember(id, env.guildId)).toBe(true);
    const plain = await env.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(superadmin.accessToken), payload: { username: 'cvLonely', displayName: 'L', password: 'correct-horse-battery' } });
    expect(plain.statusCode).toBe(201);
    expect(await env.prisma.guildMember.count({ where: { userId: plain.json<{ user: { id: string } }>().user.id } })).toBe(0);
  });
});
