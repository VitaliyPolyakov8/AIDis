import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadsMediaDirectly } from './gif.service.js';

/**
 * Structured message embeds (0.3.1), stored as JSON on the message:
 *  - link: preview card of the first link in the message (YouTube, Steam or any Open Graph page),
 *    produced by the server after the message was sent;
 *  - gif: a GIF picked in the GIF browser (provider URLs only, never re-uploaded);
 *  - game (0.5.8): a games hub news card, created by the server (never accepted from clients).
 *
 * Images are never loaded by clients from third-party hosts directly: every image URL is rewritten
 * to the server's image proxy with an HMAC signature, so the proxy can only fetch URLs the server
 * itself put into an embed (no open proxy), clients do not reveal their IP to arbitrary sites and
 * the desktop CSP stays strict.
 */
export interface EmbedImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface LinkEmbed {
  type: 'link';
  provider: 'youtube' | 'steam' | 'website';
  url: string;
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: EmbedImage | null;
  author: string | null;
  /** Steam: price as formatted by Steam itself, only when Steam reported one. */
  price: string | null;
  free: boolean;
}

export interface GifEmbed {
  type: 'gif';
  provider: 'klipy' | 'tenor' | 'giphy';
  id: string;
  /** Page on the provider's site (opened on click). */
  url: string;
  media: EmbedImage;
  preview: EmbedImage | null;
  title: string | null;
}

export type Embed = LinkEmbed | GifEmbed;

// ---- image proxy signatures ---------------------------------------------------------------

export class ImageSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Separate key derived from the server secret, used for nothing else.
    this.key = createHmac('sha256', secret).update('aidis-embed-image-proxy-v1').digest();
  }

  sign(url: string): string {
    return createHmac('sha256', this.key).update(url).digest('base64url').slice(0, 32);
  }

  verify(url: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(url));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Path of the proxied image (clients prefix it with the API origin). */
  proxyPath(url: string): string {
    return `/api/v1/embeds/image?u=${Buffer.from(url).toString('base64url')}&s=${this.sign(url)}`;
  }
}

function proxied(image: EmbedImage | null, signer: ImageSigner): EmbedImage | null {
  return image ? { ...image, url: signer.proxyPath(image.url) } : null;
}

/** What clients receive: the same embeds with image URLs pointing at the image proxy. */
export function toEmbedViews(raw: unknown, signer: ImageSigner): Embed[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((value): Embed[] => {
    const e = value as Partial<Embed> | null;
    if (e?.type === 'link') return [{ ...(e as LinkEmbed), image: proxied((e as LinkEmbed).image, signer) }];
    if (e?.type === 'gif') {
      const gif = e as GifEmbed;
      // KLIPY media is loaded directly from the URLs KLIPY returned, unchanged (their integration rules).
      if (loadsMediaDirectly(gif.provider)) return [gif];
      return [{ ...gif, media: proxied(gif.media, signer) ?? gif.media, preview: proxied(gif.preview, signer) }];
    }
    return [];
  });
}
