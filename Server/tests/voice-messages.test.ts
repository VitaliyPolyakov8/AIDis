import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceMessages, type VoiceMessage } from '../src/voice-messages/service.js';
import type { AttachmentsService } from '../src/attachments/attachments.service.js';
import type { PrismaClient } from '../src/db/prisma.js';
import type { PermissionsService } from '../src/permissions/permissions.service.js';
import type { User } from '../src/generated/prisma/client.js';

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const dirs: string[] = [];
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Missing test fixture'); return value; }
afterEach(async () => { vi.mocked(rename).mockReset(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function setup(limit = 2) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aidis-voice-')); dirs.push(dir);
  const user = { id: randomUUID() } as User;
  const records = new Map<string, { id: string; storedName: string; messageId: string | null; uploaderId: string; size: bigint }>();
  const message = { id: randomUUID(), authorId: user.id, deletedAt: null as Date | null, channel: {} };
  const visible = vi.fn(() => Promise.resolve(true));
  const attachments = { get: vi.fn((id: string) => Promise.resolve(records.get(id))), storage: { root: dir, resolve: (name: string) => path.join(dir, name), sizeOf: () => Promise.resolve(8), readHead: () => Promise.resolve(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) } };
  const prisma = { message: { findUnique: () => Promise.resolve(message) }, user: { findUnique: () => Promise.resolve(user) } };
  const worker = vi.fn((_file: string, _signal: AbortSignal) => Promise.resolve({ text: 'hello', duration: 2 }));
  const create = () => new VoiceMessages(prisma as unknown as PrismaClient, attachments as unknown as AttachmentsService, { canView: visible } as unknown as PermissionsService, worker, limit);
  const service = create(); await service.init();
  const add = async (attached = false) => {
    const id = randomUUID(); records.set(id, { id, storedName: randomUUID(), messageId: null, uploaderId: user.id, size: 8n });
    await service.register(user, id);
    if (attached) required(records.get(id)).messageId = message.id;
    return id;
  };
  return { service, create, user, records, message, visible, worker, add, dir, attachments };
}

describe('durable local voice messages', () => {
  it('persists metadata through a transient Windows atomic-replace sharing violation', async () => {
    const s = await setup();
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code: 'EPERM' }));
    const id = await s.add();
    expect((await s.service.get(s.user, id))?.status).toBe('draft');
    await s.service.close();
  });
  it('only queues registered attached audio and serializes workers; queue is bounded and survives restart', async () => {
    const s = await setup(2);
    const resolve: ((value: { text: string; duration: number }) => void)[] = [];
    s.worker.mockImplementation(() => new Promise(r => resolve.push(r)));
    const a = await s.add(true); const b = await s.add(true); const c = await s.add(true); const draft = await s.add();
    await s.service.queueAttached([a, b, c, draft, randomUUID()]);
    await vi.waitFor(() => { expect(s.worker).toHaveBeenCalledTimes(1); });
    expect((await s.service.get(s.user, c))?.error).toBe('queue-full');
    expect((await s.service.get(s.user, draft))?.status).toBe('draft');
    const closing = s.service.close(); required(resolve[0])({ text: 'hello', duration: 2 }); await closing;
    expect((await s.service.get(s.user, a))?.status).toBe('done');
    const restored = s.create(); await restored.init();
    await vi.waitFor(() => { expect(s.worker).toHaveBeenCalledTimes(2); });
    required(resolve[1])({ text: 'world', duration: 3 });
    await vi.waitFor(async () => { expect({ status: (await restored.get(s.user, b))?.status, files: s.worker.mock.calls.map(call => path.basename(call[0])) }).toEqual({ status: 'done', files: [required(s.records.get(a)).storedName, required(s.records.get(b)).storedName] }); }, { timeout: 5000 });
    expect((await restored.get(s.user, a))?.text).toBe('hello');
    await restored.close();
  });

  it('checks current channel visibility even for the uploader and denies deleted messages', async () => {
    const s = await setup(); const id = await s.add(true);
    s.visible.mockResolvedValue(false);
    await expect(s.service.get(s.user, id)).rejects.toMatchObject({ statusCode: 404 });
    s.visible.mockResolvedValue(true); s.message.deletedAt = new Date();
    await expect(s.service.get(s.user, id)).rejects.toMatchObject({ statusCode: 404 });
    await s.service.close();
  });

  it('rejects another uploader and actual oversized/spoofed files before queueing', async () => {
    const s = await setup(); const id = await s.add();
    await expect(s.service.register({ id: randomUUID() } as User, id)).rejects.toMatchObject({ statusCode: 404 });
    required(s.records.get(id)).size = 21n * 1024n * 1024n;
    await expect(s.service.register(s.user, id)).rejects.toMatchObject({ statusCode: 413 });
    expect(s.worker).not.toHaveBeenCalled(); await s.service.close();
  });

  it('bounds attempts even after repeated interrupted process restarts', async () => {
    const s = await setup(); const id = await s.add();
    const record = await s.service.get(s.user, id); await s.service.close();
    required(s.records.get(id)).messageId = s.message.id;
    await writeFile(path.join(s.dir, '.voice-messages', `${id}.json`), JSON.stringify({ ...record, status: 'processing', attempts: 3 }));
    await writeFile(path.join(s.dir, '.voice-messages', 'queue.json'), JSON.stringify([id]));
    const restored = s.create(); await restored.init();
    await vi.waitFor(async () => { expect((await restored.get(s.user, id))?.status).toBe('failed'); });
    expect(s.worker).not.toHaveBeenCalled(); await restored.close();
  });

  it('rejects actual oversized files and spoofed containers despite harmless upload metadata', async () => {
    const s = await setup(); const id = await s.add();
    s.attachments.storage.sizeOf = () => Promise.resolve(21 * 1024 * 1024);
    await expect(s.service.register(s.user, id)).rejects.toMatchObject({ statusCode: 413 });
    s.attachments.storage.sizeOf = () => Promise.resolve(8);
    s.attachments.storage.readHead = () => Promise.resolve(Buffer.from('<html>'));
    await expect(s.service.register(s.user, id)).rejects.toMatchObject({ statusCode: 400 });
    await s.service.close();
  });

  it('does not process deleted messages or revoked author access while audio remains stored', async () => {
    const s = await setup(); const id = await s.add(true);
    s.visible.mockResolvedValue(false);
    await s.service.queueAttached([id]);
    await vi.waitFor(async () => { const record = JSON.parse(await readFile(path.join(s.dir, '.voice-messages', `${id}.json`), 'utf8')) as VoiceMessage; expect(record.error).toBe('transcription-failed'); });
    expect(s.worker).not.toHaveBeenCalled(); expect(s.records.has(id)).toBe(true);
    await s.service.close();
  });
});
