import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { parseInput } from '../common/validation.js';
import { Errors } from '../common/errors.js';
import type { ImageSigner } from './embeds.js';
import { GifProviderError, type GifService } from './gif.service.js';
import { FetchBlockedError, safeFetch } from './safe-fetch.js';
import type { LinkPreviewService } from './link-preview.service.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const gifQuery = z.object({
  q: z.string().max(100).default(''),
  limit: z.coerce.number().int().min(8).max(50).default(24),
  page: z.coerce.number().int().min(1).max(100).default(1),
});
const imageQuery = z.object({ u: z.string().min(1).max(4000), s: z.string().min(10).max(64) });
const steamAppParams = z.object({ appId: z.coerce.number().int().min(1).max(99_999_999) });

export function embedsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  gifs: GifService,
  signer: ImageSigner,
  links: Pick<LinkPreviewService, 'steamArt' | 'steamAppIdByName'> | null = null,
  fetcher: typeof safeFetch = safeFetch,
): void {
  const { requireAuth } = ctx.hooks;

  /**
   * 0.5.2: real Steam artwork URLs of a game (activity cards). Newer games only have hashed image
   * paths, which clients cannot guess and cannot look up themselves (the store API has no CORS).
   * Null fields = Steam has no such image (or the lookup failed; retried after 30 min).
   */
  app.get('/steam/apps/:appId/art', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { appId } = parseInput(steamAppParams, request.params);
    const art = links && ctx.config.steamArt ? await links.steamArt(appId) : null;
    void reply.header('Cache-Control', 'private, max-age=3600');
    return { appId, header: art?.header ?? null, capsule: art?.capsule ?? null };
  });

  /** 0.5.8: Steam id of a game by name (games detected without one); null when there is no clear match. */
  app.get('/steam/app-by-name', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { name } = parseInput(z.object({ name: z.string().trim().min(2).max(128) }), request.query);
    const appId = links && ctx.config.steamArt ? await links.steamAppIdByName(name) : null;
    void reply.header('Cache-Control', 'private, max-age=3600');
    return { appId };
  });

  /**
   * Server-backed GIF search / trending (Tenor, GIPHY; the provider key never reaches clients).
   * KLIPY never goes through here: the client talks to KLIPY directly. Provider trouble becomes a
   * clean 503 and never affects anything else.
   */
  app.get('/gifs', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const { q, limit, page } = parseInput(gifQuery, request.query);
    if (!gifs.enabled) return { enabled: false, provider: null, results: [], nextPage: null };
    try {
      const found = await gifs.search(q, limit, page);
      return {
        enabled: true,
        provider: gifs.providerName,
        nextPage: found.nextPage,
        results: found.results.map((r) => ({ ...r, previewProxy: signer.proxyPath(r.preview.url), mediaProxy: signer.proxyPath(r.media.url) })),
      };
    } catch (error) {
      const kind = error instanceof GifProviderError ? error.kind : 'unavailable';
      // Reason only (e.g. "provider rate limit"); never the request URL, which contains the key.
      request.log.warn({ event: 'gifs.provider_failed', provider: gifs.providerName, reason: error instanceof GifProviderError ? error.reason : 'unexpected error' }, 'GIF provider failed');
      if (kind === 'rate_limited') throw Errors.serviceUnavailable('GIF_RATE_LIMITED', 'GIF service is temporarily unavailable. Please try again later.');
      throw Errors.serviceUnavailable('GIF_PROVIDER_UNAVAILABLE', 'GIF service is temporarily unavailable. Please try again later.');
    }
  });

  /**
   * Image proxy for embeds. Only URLs signed by this server (they come from stored embeds or GIF
   * results), fetched with the SSRF-safe client, images only (no SVG), at most 10 MB.
   */
  app.get('/embeds/image', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { u, s } = parseInput(imageQuery, request.query);
    let url: string;
    try {
      url = Buffer.from(u, 'base64url').toString('utf8');
    } catch {
      throw Errors.badRequest('INVALID_IMAGE', 'Invalid image reference');
    }
    if (!signer.verify(url, s)) throw Errors.forbidden('Invalid image signature');
    try {
      const res = await fetcher(url, { accept: IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES + 1, timeoutMs: 8000 });
      if (res.truncated || res.body.length > MAX_IMAGE_BYTES) return await reply.status(413).send({ error: { code: 'IMAGE_TOO_LARGE', message: 'Image is too large' } });
      return await reply
        .header('Content-Type', res.contentType.split(';')[0] ?? 'application/octet-stream')
        .header('Cache-Control', 'public, max-age=86400, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(res.body);
    } catch (error) {
      request.log.info({ event: 'embeds.image_failed', blocked: error instanceof FetchBlockedError, reason: error instanceof Error ? error.message : 'error' }, 'Embed image unavailable');
      return await reply.status(502).send({ error: { code: 'IMAGE_UNAVAILABLE', message: 'Image is not available' } });
    }
  });
}
