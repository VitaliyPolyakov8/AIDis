import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { createTestEnv } from './helpers.js';

type Env = Awaited<ReturnType<typeof createTestEnv>>;

interface ClientConfig {
  server: { name: string; version: string };
  livekitUrl: string;
  voiceNodeDomain: string;
  gifs: string;
  steamArt: boolean;
  desktop: { latestVersion: string; minimumVersion: string; updateMirrorUrl: string | null };
}

describe('GET /api/v1/client/config (what the desktop app learns about a server)', () => {
  let env: Env;
  let dir: string;
  const versionFile = () => path.join(dir, 'client-version.json');
  const get = async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/client/config' });
    expect(res.statusCode).toBe(200);
    return res.json<ClientConfig>();
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'aidis-client-config-'));
    await writeFile(versionFile(), JSON.stringify({ desktop: { latestVersion: '1.0.3', minimumVersion: '1.0.1', updateMirrorUrl: 'https://updates.example.com/aidis/' } }));
    env = await createTestEnv({ PUBLIC_BASE_URL: 'https://chat.example.com', VOICE_NODE_DOMAIN: '', CLIENT_VERSION_FILE: versionFile() });
  });
  afterAll(async () => {
    await env.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers without logging in, with the voice domain taken from PUBLIC_BASE_URL', async () => {
    const body = await get();
    expect(body.server.name).toBe('AIDis');
    expect(body.server.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.livekitUrl).toBe(env.config.livekit.publicUrl);
    expect(body.voiceNodeDomain).toBe('chat.example.com');
    expect(body.gifs).toBe('none');
    expect(body.desktop).toEqual({ latestVersion: '1.0.3', minimumVersion: '1.0.1', updateMirrorUrl: 'https://updates.example.com/aidis/' });
  });

  it('turns Steam artwork off by default and does not ask Steam then', async () => {
    expect((await get()).steamArt).toBe(false);
    const art = await env.app.inject({ method: 'GET', url: '/api/v1/steam/apps/620/art', headers: { authorization: 'Bearer nope' } });
    expect(art.statusCode).toBe(401);
  });

  it('keeps only an https update mirror', async () => {
    await writeFile(versionFile(), JSON.stringify({ desktop: { latestVersion: '1.0.3', minimumVersion: '1.0.1', updateMirrorUrl: 'http://updates.example.com/' } }));
    // The file is re-read when its modification time changes.
    await new Promise((r) => setTimeout(r, 20));
    expect((await get()).desktop.updateMirrorUrl).toBeNull();
  });
});

describe('configuration defaults without our domains', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'pglite://memory', JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789' };

  it('VOICE_NODE_DOMAIN follows PUBLIC_BASE_URL unless set', () => {
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: 'https://talk.example.org' }).voiceNodeDomain).toBe('talk.example.org');
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: 'https://talk.example.org', VOICE_NODE_DOMAIN: 'voice.example.org' }).voiceNodeDomain).toBe('voice.example.org');
  });

  it('STEAM_ART is off unless switched on', () => {
    expect(loadConfig(base).steamArt).toBe(false);
    expect(loadConfig({ ...base, STEAM_ART: 'true' }).steamArt).toBe(true);
  });

  it('nothing in the defaults points at a particular installation', () => {
    const json = JSON.stringify(loadConfig(base));
    expect(json).not.toMatch(new RegExp(['frie' + 'comp', 'dis' + 'cro'].join('|')));
  });
});
