import { mkdtemp, rm } from 'node:fs/promises';
import { applyMigrations } from './migrations.js';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { io as connectClient, type Socket } from 'socket.io-client';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config/env.js';
import type { GuildTemplate } from '../src/guilds/template.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { UsersService } from '../src/users/users.service.js';

export const TEST_PASSWORD = 'correct-horse-battery';
export const LIVEKIT_TEST_SECRET = 'test-livekit-secret-0123456789abcdef0123456789';

/**
 * Builds a full application against an in-process PostgreSQL (PGlite, WebAssembly).
 * No database server, Docker or network service is started; the HTTP server only
 * listens on 127.0.0.1 with a random port when a test needs Socket.IO.
 */
export interface TestEnv extends BuiltApp {
  prisma: PrismaClient;
  config: AppConfig;
  users: UsersService;
  uploadDir: string;
  /** 0.7.0: the "AIDis" server every createUser() joins by default, and its owner. */
  guildId: string;
  ownerId: string;
  close: () => Promise<void>;
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'aidis-test-uploads-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    LINK_PREVIEWS: 'false',
    DATABASE_URL: 'pglite://memory',
    JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
    LIVEKIT_URL: 'wss://rtc.aidis.test',
    VOICE_NODE_DOMAIN: 'aidis.test',
    LIVEKIT_API_URL: 'http://127.0.0.1:1',
    LIVEKIT_API_KEY: 'test-key',
    LIVEKIT_API_SECRET: LIVEKIT_TEST_SECRET,
    UPLOAD_DIRECTORY: uploadDir,
    MAX_UPLOAD_SIZE: String(1024 * 1024),
    RATE_LIMIT_MAX: '100000',
    LOGIN_RATE_LIMIT_MAX: '100000',
    CORS_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
  const pg = new PGlite();
  await applyMigrations(pg);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  const built = await buildApp({ config, prisma, logger: false });
  await built.app.ready();
  const users = new UsersService(prisma);
  // One "AIDis" server with the classic channel names; createUser() joins it unless told otherwise.
  const owner = await users.create({ username: 'test-owner', displayName: 'test-owner', password: TEST_PASSWORD, role: 'USER' });
  const guild = await built.ctx.services.guilds.createFromTemplate(owner.id, 'AIDis', LEGACY_TEMPLATE);
  return {
    ...built,
    prisma,
    config,
    users,
    uploadDir,
    guildId: guild.id,
    ownerId: owner.id,
    close: async () => {
      await built.app.close();
      await prisma.$disconnect();
      await pg.close();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

/** The channels an installation had before 0.7.0 (many older tests use these names). */
export const LEGACY_TEMPLATE: GuildTemplate = {
  categories: [
    {
      name: 'Текстовые каналы',
      channels: [
        { type: 'TEXT', name: 'general', protected: true },
        { type: 'TEXT', name: 'games' },
        { type: 'TEXT', name: 'random' },
      ],
    },
    {
      name: 'Голосовые каналы',
      channels: [
        { type: 'VOICE', name: 'General', protected: true },
        { type: 'VOICE', name: 'Gaming' },
        { type: 'VOICE', name: 'AFK' },
      ],
    },
  ],
};

export async function createUser(env: TestEnv, username: string, role: 'ADMIN' | 'USER' = 'USER', opts: { join?: boolean } = {}) {
  const user = await env.users.create({ username, displayName: username, password: TEST_PASSWORD, role });
  if (opts.join !== false) await env.ctx.services.guilds.join(user.id, env.guildId);
  return user;
}

/**
 * A pre-0.7 "private channel" in the new model: @everyone may not see it, the listed people / roles
 * may. Created in the test server unless another one is given.
 */
export async function createPrivateChannel(env: TestEnv, name: string, opts: { type?: 'TEXT' | 'VOICE'; userIds?: string[]; roleIds?: string[]; guildId?: string } = {}) {
  const guildId = opts.guildId ?? env.guildId;
  const everyone = await env.prisma.roleDef.findFirstOrThrow({ where: { guildId, key: 'everyone' } });
  const channel = await env.prisma.channel.create({ data: { guildId, name, type: opts.type ?? 'TEXT', permissionsSynced: false } });
  await env.prisma.permissionOverwrite.createMany({
    data: [
      { channelId: channel.id, targetType: 'ROLE', targetId: everyone.id, allow: [], deny: ['VIEW_CHANNEL'] },
      ...(opts.userIds ?? []).map((id) => ({ channelId: channel.id, targetType: 'MEMBER' as const, targetId: id, allow: ['VIEW_CHANNEL'], deny: [] })),
      ...(opts.roleIds ?? []).map((id) => ({ channelId: channel.id, targetType: 'ROLE' as const, targetId: id, allow: ['VIEW_CHANNEL'], deny: [] })),
    ],
  });
  env.ctx.services.permissions.invalidateGuild(guildId);
  return channel;
}

/** Makes two users friends directly (DMs need friendship since 0.7.0). */
export async function befriend(env: TestEnv, a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await env.prisma.friendship.upsert({ where: { userAId_userBId: { userAId, userBId } }, create: { userAId, userBId }, update: {} });
  env.ctx.services.permissions.invalidateAll();
  env.ctx.services.friends.invalidate();
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  user: { id: string; username: string };
}

export async function login(env: TestEnv, username: string, password = TEST_PASSWORD): Promise<LoginResult> {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, clientType: 'desktop', deviceName: 'test' },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  }
  return res.json<LoginResult>();
}

/** Logs several users in at once; the result keeps the tuple shape of `names`. */
export async function loginAll<const T extends readonly string[]>(env: TestEnv, names: T): Promise<{ [K in keyof T]: LoginResult }> {
  return (await Promise.all(names.map((n) => login(env, n)))) as { [K in keyof T]: LoginResult };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function getTextChannelId(env: TestEnv, name = 'general', guildId = env.guildId): Promise<string> {
  const channel = await env.prisma.channel.findFirstOrThrow({ where: { guildId, type: 'TEXT', name } });
  return channel.id;
}

export async function getVoiceChannelId(env: TestEnv, name = 'General', guildId = env.guildId): Promise<string> {
  const channel = await env.prisma.channel.findFirstOrThrow({ where: { guildId, type: 'VOICE', name } });
  return channel.id;
}

/** Starts listening on a random loopback port (needed for Socket.IO tests). */
export async function listen(env: TestEnv): Promise<string> {
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

export function connectSocket(baseUrl: string, token?: string, extraAuth: Record<string, unknown> = {}): Socket {
  return connectClient(baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: token ? { token, ...extraAuth } : {},
  });
}

export function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
