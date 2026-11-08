# AIDis Desktop

The Windows app for AIDis: the shared React client (`../Client`) inside a hardened Electron shell
that adds global hotkeys, true push-to-talk, a native screen/window picker with system audio,
stream quality controls, tray, autostart, native notifications, game activity and encrypted login
storage.

**One app for every AIDis server.** Nothing about a particular installation is compiled in: on the
first start the app asks for a server address (`chat.example.com`), checks that it is an AIDis
and remembers it. Several servers can be added and switched in Settings → Desktop.

- Version: single source `package.json` → `app.getVersion()`, shown in Settings → About
- appId: **`io.aidis.app`** (installer upgrades, notifications and autostart depend on it; a fork
  that ships its own builds should pick its own)
- Electron 44, electron-builder 26, TypeScript, esbuild
- Windows 11 x64 (the code is portable; macOS/Linux builds are not configured)

## 1. Architecture

```
AIDis/
├── Server/    backend
├── Client/    THE React UI, used by the web build and by this app
└── Desktop/   Electron shell (this folder)
    ├── src/main/        main process (window, tray, hotkeys, capture, storage, servers, IPC, logs)
    ├── src/preload/     the only bridge: window.aidisDesktop
    ├── src/shared/      IPC channel names
    ├── assets/          aidis.ico, aidis-logo.png
    ├── scripts/         build.mjs (production), dev.mjs (hot-reload dev), shared.mjs
    ├── test/            unit tests (vitest) + e2e/smoke.cjs (built app, real key presses)
    ├── desktop.config.json  where releases are published (GitHub owner/repo)
    ├── build/           generated: renderer/ (bundled client), main/, preload/
    └── dist/            generated: AIDis-Setup-<version>.exe, win-unpacked/
```

**No second UI.** `scripts/build.mjs` runs the Client's own Vite build (with an empty API origin)
into `Desktop/build/renderer`. The main process serves those files from a privileged custom
scheme, **`aidis://app/`** (secure context for microphone and capture, BrowserRouter paths fall
back to `index.html`, path traversal is impossible). The UI ships inside the installer; only the
chosen server's API, Socket.IO and LiveKit are remote.

**Servers** (`src/main/servers.ts`). `servers.json` in the user data folder holds the known
servers and the current one. Adding a server normalizes the address (https only; `http://localhost`
only in development), asks `GET /api/v1/client/config` (an older AIDis: `GET /api/v1/version`) and
refuses anything that is not AIDis (`NOT_HTTPS`, `INVALID`, `UNREACHABLE`, `NOT_AIDIS`, each shown
to the user in plain words). At start the current server's settings are refreshed; when it is down
the remembered ones are used. The renderer reads the current server through the preload, calls
`setApiOrigin()` and shows the "server address" screen when there is none.

**CSP per server.** The Content-Security-Policy of the bundled files is built from the current
server: its origin (HTTP + WebSocket), its LiveKit and the subdomains of its voice domain (extra
voice servers). Without a server the page can reach nothing but itself. Steam store images are
allowed only when the server enables them (`STEAM_ART`).

**CORS without touching the server** (`src/main/network.ts`). A server allows only its own web
origin. For requests from our renderer to the current server (fetch, Socket.IO polling and its
WebSocket upgrade) the main process presents that origin and maps `Access-Control-Allow-Origin`
back to `aidis://app`. Other hosts and origins are untouched and Chromium still enforces CORS.

`Client/src/desktop/contract.ts` is the single typed contract (API shape, hotkey actions, streaming
presets, settings validation). The main process imports the same file and re-validates every value
it receives.

## 2. Development

Requirements: Node 20.19+ and npm. Nothing is installed system-wide; Electron, NSIS and the other
build tools are downloaded into `node_modules` / the electron-builder cache.

```bash
cd Client && npm install
cd ../Desktop && npm install
npm run desktop:dev
```

`desktop:dev` starts the Client's Vite dev server (hot reload, `127.0.0.1:5173`), bundles main and
preload and starts Electron pointed at it. In development the app also accepts
`http://localhost:3000` as a server (a local `Server` from `npm run dev`). DevTools: F12.

| Script | What it does |
| --- | --- |
| `npm run build` | client → `build/renderer`, main/preload → `build/main`, `build/preload` |
| `npm start` | run the built app (production mode, `aidis://app`) |
| `npm run desktop:build` | `build` + Windows NSIS installer in `dist/` |
| `npm run desktop:pack` | `build` + unpacked app only (`dist/win-unpacked`) |
| `npm run typecheck` / `npm run lint` / `npm test` | TypeScript, ESLint, unit tests |
| `npm run test:e2e` | smoke test of the built app against a running server (`AIDIS_E2E_SERVER=https://…`) |

## 3. Installer and releases

```bash
npm run desktop:build
```

- `dist/AIDis-Setup-<version>.exe`: NSIS installer (x64, per-user, no admin rights, Russian/English,
  desktop + Start menu shortcuts, uninstaller in "Apps & features").
- `dist/AIDis-Setup-<version>.exe.blockmap` and `dist/latest.yml`: update metadata.

The installer is **not code-signed**, so Windows SmartScreen shows "Unknown publisher" on the first
run (More info → Run anyway). Signing can be configured in electron-builder once you have a
certificate.

### Automatic updates

`desktop.config.json` names the GitHub repository whose Releases the app updates from:

```json
{ "github": { "owner": "your-name", "repo": "AIDis" } }
```

It is compiled in at build time. The value `OWNER` means "no automatic updates" (the app never
asks a wrong repository). To release: bump `version` in `package.json`, `npm run desktop:build`,
create a GitHub Release tagged `v<version>` and attach `AIDis-Setup-<version>.exe`, its `.blockmap`
and `latest.yml`.

A server owner can also offer updates from their own server: put the three files in a folder served
over https and set `updateMirrorUrl` in the server's `config/client-version.json`. The app then
updates from that mirror instead of GitHub. The same file sets `minimumVersion`: an older app is
asked to update before it connects.

## 4. User data and logs

Everything writable lives in `%APPDATA%\AIDis` (never in Program Files):

| File | Content |
| --- | --- |
| `servers.json` | known servers and the current one (addresses and public settings, no secrets) |
| `session-<hash>.bin` | per server: refresh token + session id, **encrypted** (Windows DPAPI via `safeStorage`) |
| `settings.json` | keybinds, streaming, input mode, tray/startup/notification preferences |
| `window-state.json` | size, position, maximized |
| `logs\main.log` | app log, 2 MB rotation |

Every log line passes through a redactor that removes JWTs, bearer tokens, token/password fields
and long opaque strings. Settings → Desktop → "Open logs folder".

Login storage: the access token stays in memory; the refresh token and session id go to the main
process, encrypted and written per server. "Keep me logged in" off keeps them in memory only;
logout and removing a server delete the file. Without OS encryption the session is never written
in plain text.

## 5. Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, no
  `<webview>`, DevTools only in development.
- The preload exposes one frozen object, `window.aidisDesktop`, with fixed methods: no
  `ipcRenderer`, no Node API, no file system, no shell, no generic invoke.
- Every IPC handler checks the sender is the top frame of our window on the app origin and
  validates its arguments.
- CSP on every bundled file, built from the chosen server (see §1).
- Navigation is locked: `http(s)`/`mailto` links open in the default browser; everything else is
  refused. New windows are denied.
- Permissions: microphone (no camera), screen capture, notifications, fullscreen, clipboard write
  and output-device selection. USB/HID/serial access is denied.
- `getDisplayMedia()` is answered only with the source the user picked in our picker (one use).
- Single-instance lock: a second launch focuses the running window.

| `window.aidisDesktop` group | Methods |
| --- | --- |
| `servers` | `list()`, `current()`, `add(address)`, `select(origin)`, `remove(origin)` |
| `app` | `getInfo()`, `log()`, `relaunch()`, `openLogsFolder()`, `downloadUrl()`, `onNavigate()` |
| `auth` | `load()`, `save()`, `clear()` (the session of the current server) |
| `settings` | `get()`, `update(patch)`, `onChange()` |
| `hotkeys` | `getStatus()`, `setCapturing()`, `onCommand()`, `onPushToTalk()`, `onStatus()` |
| `voice`, `capture`, `notifications`, `presence`, `updates` | see `Client/src/desktop/contract.ts` |

## 6. Features in short

- **Global hotkeys** (mute, deafen, show/hide and more) work while a game has focus; conflicts are
  shown instead of silently overridden.
- **Push-to-talk** uses a low-level input hook, so it works in games that swallow hotkeys. Games
  running as administrator hide their input from it unless AIDis runs elevated too.
- **Screen sharing** with a native picker, presets up to 1440p60 and Windows system audio (the
  whole system mix, not one application).
- **Game activity**: the running game is shown to others (can be hidden per game) and recorded in
  the game tracker with play time.
- **Tray, autostart, native notifications**, per-user volume, connection quality and ping.

## 7. Tests

- `npm test`: servers and CSP, update feed, log redaction, key mapping, `aidis://` path resolution,
  the CORS bridge, window state, notifications, link policy, overlays, presence.
- `npm run test:e2e` (after `npm run build`, with `AIDIS_E2E_SERVER` set): launches the built app
  with an isolated profile and checks loading from `aidis://app`, CSP, the CORS bridge against a
  real server, encrypted session storage, global hotkeys with real key presses, capture, tray and
  single instance. It sends real key presses: do not run it while you are in a call.
- Client: `npm test` in `../Client` covers the desktop contract, the server screen, PTT logic, the
  voice gate and the desktop-only settings.
