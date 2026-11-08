import type { AidisDesktopApi } from './contract';

declare global {
  interface Window {
    /** Present only inside AIDis Desktop; injected by the Electron preload script via contextBridge. */
    readonly aidisDesktop?: AidisDesktopApi;
  }
}

/**
 * Desktop detection. The Electron preload explicitly exposes `window.aidisDesktop` with
 * `isDesktop: true`; there is no user-agent sniffing. In a normal browser this is null and every
 * desktop-only feature stays hidden.
 */
function detect(): AidisDesktopApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.aidisDesktop;
  return api?.isDesktop === true ? api : null;
}

export const desktop: AidisDesktopApi | null = detect();
export const isDesktop: boolean = desktop !== null;
