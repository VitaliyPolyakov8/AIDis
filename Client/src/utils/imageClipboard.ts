/**
 * 0.5.0 "Copy image" for chat images (attachments, link-preview images, GIFs).
 *
 * The image is fetched again (it is already cached: an object URL for attachments, the server's
 * image proxy for previews), decoded and written to the clipboard as a real bitmap (PNG) through
 * the standard async Clipboard API. In the desktop app (Chromium) Windows gets a bitmap that pastes
 * into Paint, Telegram, browsers and the AIDis composer. Animated GIF / WebP: the clipboard holds
 * a still picture (the first frame); "Copy image link" copies the original. Browsers without image
 * clipboard support (or without permission) get a clear error and can copy the link instead.
 */

export type CopyImageResult = 'copied' | 'unsupported' | 'failed';

export function canCopyImages(): boolean {
  return typeof navigator !== 'undefined' && 'clipboard' in navigator && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined';
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('encode'))), 'image/png');
    });
  } finally {
    bitmap.close();
  }
}

async function imageElementToPng(src: string): Promise<Blob> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(img, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('encode'))), 'image/png');
  });
}

/** Copies the picture behind `src` (object URL, same-origin proxy URL or data URL) as a bitmap. */
export async function copyImageFromUrl(src: string): Promise<CopyImageResult> {
  if (!canCopyImages()) return 'unsupported';
  try {
    // The clipboard write must start inside the user gesture: pass a promise of the PNG.
    // blob: / data: URLs (attachments) are decoded through an <img> (the desktop app's CSP allows
    // them as images, not as fetch targets); proxied previews are fetched from the API origin.
    const png = /^(blob|data):/.test(src)
      ? imageElementToPng(src)
      : fetch(src)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
          })
          .then(toPng);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return 'copied';
  } catch (error) {
    return error instanceof DOMException && error.name === 'NotAllowedError' ? 'unsupported' : 'failed';
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
