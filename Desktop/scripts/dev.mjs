// Development: Vite dev server for the shared client (hot reload) + Electron pointed at it.
// The renderer talks to the server chosen in the app (http://localhost is allowed in development).
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { buildElectron, clientDir, desktopDir, viteBin } from './shared.mjs';

const PORT = 5173;

function waitForPort(port, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`Vite did not start on port ${port}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: clientDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_API_URL: '', VITE_LIVEKIT_URL: '' },
});

let electron = null;
const stop = (code = 0) => {
  electron?.kill();
  vite.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
vite.on('exit', (code) => {
  if (code) stop(code);
});

await buildElectron({ dev: true });
await waitForPort(PORT);
const electronBin = (await import('electron')).default;
electron = spawn(electronBin, ['.'], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: { ...process.env, AIDIS_DEV_SERVER_URL: `http://127.0.0.1:${PORT}` },
});
electron.on('exit', (code) => stop(code ?? 0));
