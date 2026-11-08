// Production build: shared React client -> build/renderer, main + preload -> build/main, build/preload.
// The web build (Client/dist) is never touched; electron-builder then packs build/ into dist/.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildElectron, clientDir, desktopDir, releaseSource, rendererOutDir, viteBin } from './shared.mjs';

const { owner, repo } = releaseSource();
rmSync(resolve(desktopDir, 'build'), { recursive: true, force: true });

console.log(`Building shared client for desktop (updates from github.com/${owner}/${repo}; the server is chosen in the app)…`);
const vite = spawnSync(process.execPath, [viteBin, 'build', '--mode', 'desktop', '--outDir', rendererOutDir, '--emptyOutDir'], {
  cwd: clientDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_API_URL: '', VITE_LIVEKIT_URL: '' },
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

console.log('Bundling Electron main and preload…');
await buildElectron({ dev: false });
console.log('Desktop build ready in build/.');
