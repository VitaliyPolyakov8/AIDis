/**
 * AIDis user administration CLI.
 *
 *   npm run user:create           [-- --username Alex --display-name "Alex" --role USER]
 *   npm run user:list
 *   npm run user:disable          [-- <username>]
 *   npm run user:enable           [-- <username>]
 *   npm run user:password         [-- <username>]
 *   npm run user:role             [-- <username> <ADMIN|USER>]
 *   npm run user:sessions         [-- <username>]
 *   npm run user:revoke-sessions  [-- <username>]
 *
 * Inside Docker:  docker compose exec backend npm run user:create
 *
 * Passwords are never accepted as command-line arguments (they would end up in shell
 * history and process lists). They are typed at a hidden prompt, or piped on stdin.
 */
import { parseArgs } from 'node:util';
import { createPrismaClient, type PrismaClient } from '../db/prisma.js';
import { AppError } from '../common/errors.js';
import { UsersService } from '../users/users.service.js';
import type { Role, User } from '../generated/prisma/client.js';
import { Prompter } from './prompt.js';

const prompt = new Prompter();

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString().replace('T', ' ').slice(0, 19) : '-';
}

function parseRole(value: string): Role {
  const upper = value.trim().toUpperCase();
  if (upper !== 'ADMIN' && upper !== 'USER') fail('Role must be ADMIN or USER');
  return upper;
}

async function askNewPassword(): Promise<string> {
  const password = await prompt.askHidden('Password: ');
  const confirm = await prompt.askHidden('Repeat password: ');
  if (password !== confirm) fail('Passwords do not match');
  return password;
}

async function resolveUser(users: UsersService, positional: string | undefined): Promise<User> {
  const username = positional ?? (await prompt.ask('Username: '));
  if (!username) fail('Username is required');
  return users.getByUsername(username);
}

async function create(users: UsersService, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      username: { type: 'string' },
      'display-name': { type: 'string' },
      role: { type: 'string' },
    },
    allowPositionals: false,
  });
  const username = values.username ?? (await prompt.ask('Username: '));
  const displayNameInput = values['display-name'] ?? (await prompt.ask(`Display name [${username}]: `));
  const displayName = displayNameInput === '' ? username : displayNameInput;
  const password = await askNewPassword();
  const roleInput = values.role ?? (await prompt.ask('Role (ADMIN/USER) [USER]: '));
  const role = parseRole(roleInput === '' ? 'USER' : roleInput);

  const user = await users.create({ username, displayName, password, role });
  console.log(`User created successfully: ${user.username} (${user.role}), id ${user.id}`);
}

async function list(users: UsersService): Promise<void> {
  const all = await users.list();
  if (all.length === 0) {
    console.log('No users yet. Create the first admin with: npm run user:create');
    return;
  }
  const rows = all.map((u) => ({
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    status: u.disabled ? 'DISABLED' : 'active',
    lastSeen: formatDate(u.lastSeenAt),
    created: formatDate(u.createdAt),
  }));
  console.table(rows);
}

async function setDisabled(users: UsersService, args: string[], disabled: boolean): Promise<void> {
  const user = await resolveUser(users, args[0]);
  if (disabled && user.role === 'ADMIN') {
    const admins = (await users.list()).filter((u) => u.role === 'ADMIN' && !u.disabled);
    if (admins.length <= 1) fail('Refusing to disable the last active ADMIN');
  }
  await users.setDisabled(user.id, disabled);
  console.log(
    disabled
      ? `User ${user.username} disabled. All sessions revoked; open realtime connections drop within a minute.`
      : `User ${user.username} enabled.`,
  );
}

async function password(users: UsersService, args: string[]): Promise<void> {
  const user = await resolveUser(users, args[0]);
  const pw = await askNewPassword();
  await users.setPassword(user.id, pw);
  console.log(`Password changed for ${user.username}. All existing sessions were revoked.`);
}

async function role(users: UsersService, args: string[]): Promise<void> {
  const user = await resolveUser(users, args[0]);
  const roleInput = args[1] ?? (await prompt.ask('New role (ADMIN/USER): '));
  const updated = await users.setRole(user.id, parseRole(roleInput));
  console.log(`Role of ${updated.username} is now ${updated.role}.`);
}

async function sessions(prisma: PrismaClient, users: UsersService, args: string[]): Promise<void> {
  const user = await resolveUser(users, args[0]);
  const active = await prisma.session.findMany({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  });
  if (active.length === 0) {
    console.log(`${user.username} has no active sessions.`);
    return;
  }
  console.table(
    active.map((s) => ({
      id: s.id,
      client: s.clientType,
      device: s.deviceName ?? '-',
      ip: s.ipAddress ?? '-',
      lastUsed: formatDate(s.lastUsedAt),
      expires: formatDate(s.expiresAt),
    })),
  );
}

async function revokeSessions(prisma: PrismaClient, users: UsersService, args: string[]): Promise<void> {
  const user = await resolveUser(users, args[0]);
  const result = await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'revoked_by_admin' },
  });
  console.log(`Revoked ${result.count} session(s) of ${user.username}. Realtime connections drop within a minute.`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL is not set');

  const prisma = createPrismaClient(databaseUrl);
  const users = new UsersService(prisma);
  try {
    switch (command) {
      case 'create':
        await create(users, args);
        break;
      case 'list':
        await list(users);
        break;
      case 'disable':
        await setDisabled(users, args, true);
        break;
      case 'enable':
        await setDisabled(users, args, false);
        break;
      case 'password':
        await password(users, args);
        break;
      case 'role':
        await role(users, args);
        break;
      case 'sessions':
        await sessions(prisma, users, args);
        break;
      case 'revoke-sessions':
        await revokeSessions(prisma, users, args);
        break;
      default:
        fail(`Unknown command "${command ?? ''}". Use: create | list | disable | enable | password | role | sessions | revoke-sessions`);
    }
  } catch (error) {
    if (error instanceof AppError) {
      const details = Array.isArray(error.details)
        ? (error.details as { message: string }[]).map((d) => `\n  - ${d.message}`).join('')
        : '';
      fail(`${error.message}${details}`);
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
