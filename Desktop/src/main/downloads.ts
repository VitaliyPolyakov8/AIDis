import { IS_DEV, RENDERER_ORIGIN } from './config';

/** 0.5.5: a signed attachment content link of the AIDis API (what IPC.appDownloadUrl accepts). */
export function isAttachmentDownloadUrl(value: string, apiOrigin: string | null, origins: readonly string[] = apiOrigin ? (IS_DEV ? [apiOrigin, RENDERER_ORIGIN] : [apiOrigin]) : []): boolean {
  try {
    const url = new URL(value);
    return origins.includes(url.origin) && /^\/api\/v1\/attachments\/[0-9a-f-]{36}\/content$/.test(url.pathname) && url.searchParams.has('t');
  } catch {
    return false;
  }
}
