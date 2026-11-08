# AIDis Client

The web client of AIDis (React 19, Zustand, i18next, LiveKit). The same build runs in browsers,
inside the desktop app (`../Desktop`) and as an installable web app on phones.

Installing AIDis on a server? Use `deploy/setup.sh` and the guides in [`docs/`](../docs).

## Development

```bash
npm ci
npm run dev          # Vite on http://localhost:5173, proxies /api and /socket.io to DEV_PROXY_TARGET
npm test             # vitest (jsdom)
npx tsc -b --noEmit  # types
npm run lint
npm run build        # production files in dist/
```

Run a server locally (see `../Server/README.md`) and keep `DEV_PROXY_TARGET=http://localhost:3000`
in `.env.local`.

## Layout

| Folder | What is there |
|---|---|
| `src/pages` | login, sign-up, first-run wizard, chat, voice |
| `src/components` | chat, servers, settings, administration, profiles |
| `src/voice`, `src/sounds-board` | LiveKit calls, streams, soundboard |
| `src/games` | game tracker |
| `src/realtime` | Socket.IO client |
| `src/i18n` | Russian and English (tests keep both in sync) |
| `src/desktop` | the bridge to the desktop app |

## License

AGPL-3.0 — see [`LICENSE`](../LICENSE).
