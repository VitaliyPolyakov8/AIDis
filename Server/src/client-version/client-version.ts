import { readFile, stat } from 'node:fs/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';

const releaseSchema = z.object({
  latestVersion: z.string().regex(/^\d+\.\d+\.\d+([-+].*)?$/),
  minimumVersion: z.string().regex(/^\d+\.\d+\.\d+([-+].*)?$/),
  downloadUrl: z.string().default(''),
  mandatory: z.boolean().default(false),
  releaseNotes: z.array(z.string()).default([]),
  /** Optional mirror of the desktop updates on the owner's server (https only; otherwise GitHub Releases). */
  updateMirrorUrl: z.string().trim().max(500).optional(),
});

const fileSchema = z.object({
  desktop: releaseSchema,
});

export type ReleaseInfo = Omit<z.infer<typeof releaseSchema>, 'updateMirrorUrl'> & { updateMirrorUrl: string | null };

const FALLBACK: ReleaseInfo = {
  latestVersion: '0.1.0',
  minimumVersion: '0.1.0',
  downloadUrl: '',
  mandatory: false,
  releaseNotes: [],
  updateMirrorUrl: null,
};

/**
 * Desktop update metadata, read from a JSON file the administrator can edit
 * (config/client-version.json). Re-read automatically when the file changes.
 */
export class ClientVersionService {
  private cache: { mtimeMs: number; data: z.infer<typeof fileSchema> } | undefined;

  constructor(
    private readonly filePath: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async desktop(): Promise<ReleaseInfo> {
    try {
      const info = await stat(this.filePath);
      if (this.cache?.mtimeMs !== info.mtimeMs) {
        const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
        this.cache = { mtimeMs: info.mtimeMs, data: fileSchema.parse(raw) };
      }
      const desktop = this.cache.data.desktop;
      const mirror = desktop.updateMirrorUrl && /^https:\/\/[^\s]+$/.test(desktop.updateMirrorUrl) ? desktop.updateMirrorUrl : null;
      return { ...desktop, updateMirrorUrl: mirror };
    } catch (error) {
      this.log.warn({ err: error, file: this.filePath }, 'Client version file missing or invalid; using defaults');
      return FALLBACK;
    }
  }
}

/** 0.7.0: numeric x.y.z comparison (anything after "-" or "+" is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split(/[-+]/)[0] ?? '').split('.').map((p) => Number.parseInt(p, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 0.7.0: a desktop client below minimumVersion (or without a version) must update before it may connect. */
export async function isOutdatedDesktop(service: ClientVersionService, platform: string, version: string | null): Promise<boolean> {
  if (platform !== 'desktop') return false;
  const { minimumVersion } = await service.desktop();
  return version === null || compareVersions(version, minimumVersion) < 0;
}

export function clientVersionRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Public on purpose: an outdated client must be able to learn it needs an update before logging in.
  app.get('/client/version', async () => ctx.services.clientVersion.desktop());
}

/** What the desktop app (and the web client) learns about a server before logging in. */
export interface ClientConfigView {
  server: { name: string; version: string };
  livekitUrl: string;
  voiceNodeDomain: string;
  gifs: 'none' | 'tenor' | 'giphy';
  steamArt: boolean;
  desktop: { latestVersion: string; minimumVersion: string; updateMirrorUrl: string | null };
}

export function clientConfigRoutes(app: FastifyInstance, ctx: AppContext, serverVersion: string): void {
  // Public: the desktop app reads it when a server address is added, before anyone logs in.
  app.get('/client/config', async (): Promise<ClientConfigView> => {
    const desktop = await ctx.services.clientVersion.desktop();
    return {
      server: { name: 'AIDis', version: serverVersion },
      livekitUrl: ctx.config.livekit.publicUrl,
      voiceNodeDomain: ctx.config.voiceNodeDomain,
      gifs: ctx.config.gifs.provider,
      steamArt: ctx.config.steamArt,
      desktop: { latestVersion: desktop.latestVersion, minimumVersion: desktop.minimumVersion, updateMirrorUrl: desktop.updateMirrorUrl },
    };
  });
}
