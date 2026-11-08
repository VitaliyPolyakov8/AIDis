/**
 * 0.5.9 web client as an app on iPhone / iPad (PWA from the home screen), no-op on the desktop app
 * and the Android app (they set their platform first):
 *  - marks <html> with is-ios / is-standalone, so the layout uses safe areas and touch sizes;
 *  - tracks the visible viewport (the on-screen keyboard does not resize the page on iOS);
 *  - registers the service worker (installable, quick start, opens without network);
 *  - identifies as "ios" to the realtime server (phone icon next to the name for others).
 */
import { config } from '../config';

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;

/** iPhone, iPod or iPad (iPadOS presents itself as a Mac with touch). */
export const isIosDevice = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

/** Opened from the home screen (not in a Safari tab). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return legacy || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
}

let initialized = false;

export function initWebApp(): void {
  if (initialized || config.platform !== 'web' || typeof document === 'undefined') return;
  initialized = true;
  const html = document.documentElement;
  if (isStandalone()) html.classList.add('is-standalone');
  if (isIosDevice) {
    config.platform = 'ios';
    html.classList.add('is-ios');
    trackVisualViewport();
    void import('./iosCallAudio').then(({ startIosCallAudio }) => {
      startIosCallAudio();
    });
  }
  registerServiceWorker();
}

/**
 * iOS keeps the page at full height when the keyboard opens and pans the visible part instead, so
 * fixed layouts end up under the keyboard. The visible height and offset go to CSS variables the
 * iOS layout uses (--app-height, --app-top).
 */
function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let frame = 0;
  // Tallest visible height in this orientation = no keyboard (window sizes are not reliable on iOS).
  let full = 0;
  const apply = () => {
    frame = 0;
    full = Math.max(full, vv.height);
    root.style.setProperty('--app-height', `${String(Math.round(vv.height))}px`);
    root.style.setProperty('--app-top', `${String(Math.round(vv.offsetTop))}px`);
    // The on-screen keyboard is open when the visible part is much shorter than the window.
    root.classList.toggle('keyboard-open', full - vv.height > 120);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', () => {
    full = 0;
    schedule();
  });
  apply();
}

function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(
        (registration) => {
          // A long-open app still notices a new deployment.
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
          });
        },
        () => undefined,
      );
    },
    { once: true },
  );
}
