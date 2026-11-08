// Shared helpers for the desktop build and dev scripts (plain Node, no extra dependencies).
import { copyFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const clientDir = resolve(desktopDir, '..', 'Client');
export const rendererOutDir = resolve(desktopDir, 'build', 'renderer');
/** The Client's own Vite, run with this Node binary (no shell, no npx). */
export const viteBin = resolve(clientDir, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * Where the desktop app looks for updates (GitHub Releases of this repository). No server address is
 * compiled in: one app serves every AIDis installation. Env vars override the file.
 */
export function releaseSource() {
  const file = JSON.parse(readFileSync(resolve(desktopDir, 'desktop.config.json'), 'utf8'));
  const owner = (process.env.AIDIS_GITHUB_OWNER || file.github?.owner || '').trim();
  const repo = (process.env.AIDIS_GITHUB_REPO || file.github?.repo || '').trim();
  for (const [name, value] of [
    ['owner', owner],
    ['repo', repo],
  ]) {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`desktop.config.json github.${name} is missing or invalid (got "${value}")`);
  }
  return { owner, repo };
}

/** Bundles the Electron main process and the preload script with esbuild. */
export async function buildElectron({ dev }) {
  const github = releaseSource();
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning',
    define: {
      __AIDIS_GITHUB__: JSON.stringify(github),
    },
  };
  await build({
    ...common,
    entryPoints: [resolve(desktopDir, 'src/main/main.ts')],
    outfile: resolve(desktopDir, 'build/main/main.cjs'),
    external: ['electron', 'uiohook-napi', 'electron-updater'],
  });
  // The preload runs sandboxed: it may only require('electron'), so everything else is bundled in.
  await build({
    ...common,
    entryPoints: [resolve(desktopDir, 'src/preload/preload.ts')],
    outfile: resolve(desktopDir, 'build/preload/preload.cjs'),
    external: ['electron'],
  });
  // In-game overlay (0.3.0): its own preload, a small browser script, the page and its styles.
  await build({
    ...common,
    entryPoints: [resolve(desktopDir, 'src/overlay/overlay-preload.ts')],
    outfile: resolve(desktopDir, 'build/overlay/overlay-preload.cjs'),
    external: ['electron'],
  });
  await build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning',
    entryPoints: [resolve(desktopDir, 'src/overlay/overlay.ts')],
    outfile: resolve(desktopDir, 'build/overlay/overlay.js'),
  });
  mkdirSync(resolve(desktopDir, 'build/overlay'), { recursive: true });
  await build({ bundle: true, platform: 'browser', target: 'chrome120', format: 'iife', minify: !dev, entryPoints: [resolve(desktopDir, 'src/overlay/hint.ts')], outfile: resolve(desktopDir, 'build/overlay/hint.js') });
  for (const file of ['overlay.html', 'overlay.css', 'hint.html', 'hint.css']) {
    copyFileSync(resolve(desktopDir, 'src/overlay', file), resolve(desktopDir, 'build/overlay', file));
  }
  // 0.5.1: the overlay page has no network access: it gets its own copy of the avatar frames.
  cpSync(resolve(desktopDir, '../Client/public/cosmetics/frames'), resolve(desktopDir, 'build/overlay/frames'), { recursive: true });
  // 0.5.6: the name fonts (cyrillic + latin, 400) for name styles in the overlay.
  mkdirSync(resolve(desktopDir, 'build/overlay/fonts'), { recursive: true });
  for (const font of ['unbounded', 'comfortaa', 'lobster', 'caveat', 'press-start-2p', 'russo-one']) {
    for (const subset of ['cyrillic', 'latin']) {
      const file = `${font}-${subset}-400-normal.woff2`;
      copyFileSync(resolve(desktopDir, `../Client/node_modules/@fontsource/${font}/files/${file}`), resolve(desktopDir, 'build/overlay/fonts', file));
    }
  }
  // 0.5.0 notification window: its own preload, script, page and styles.
  await build({
    ...common,
    entryPoints: [resolve(desktopDir, 'src/toast/toast-preload.ts')],
    outfile: resolve(desktopDir, 'build/toast/toast-preload.cjs'),
    external: ['electron'],
  });
  await build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning',
    entryPoints: [resolve(desktopDir, 'src/toast/toast.ts')],
    outfile: resolve(desktopDir, 'build/toast/toast.js'),
  });
  mkdirSync(resolve(desktopDir, 'build/toast'), { recursive: true });
  for (const file of ['toast.html', 'toast.css']) {
    copyFileSync(resolve(desktopDir, 'src/toast', file), resolve(desktopDir, 'build/toast', file));
  }
}
