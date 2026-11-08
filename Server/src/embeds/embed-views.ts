import { ImageSigner, toEmbedViews, type Embed } from './embeds.js';

export type { Embed } from './embeds.js';

/** Set once at startup (app.ts); message views sign embed image URLs with it. */
let signer: ImageSigner | null = null;

export function setEmbedImageSigner(value: ImageSigner): void {
  signer = value;
}

export function embedViews(raw: unknown): Embed[] {
  return signer ? toEmbedViews(raw, signer) : [];
}
