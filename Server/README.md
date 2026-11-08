# AIDis Server

The backend of AIDis: REST API, realtime gateway (Socket.IO), PostgreSQL through Prisma, LiveKit
voice tokens, file storage, mail.

Installing AIDis on a VPS? Use `deploy/setup.sh` and the guides in [`docs/`](../docs) — you do
not need anything from this file.

## Development

Requirements: Node.js 24, npm. Tests run on an in-memory PostgreSQL (PGlite); no Docker needed.

```bash
npm ci
npx prisma generate
npm test           # vitest
npx tsc --noEmit   # types
npm run lint
```

Run locally against your own PostgreSQL:

```bash
cp .env.example .env   # set DATABASE_URL, JWT_ACCESS_SECRET, LIVEKIT_* for development
npx prisma migrate deploy
npm run dev
```

## Layout

| Folder | What is there |
|---|---|
| `src/auth`, `src/registration`, `src/mail` | log in, sessions, sign-up, password reset, SMTP |
| `src/guilds`, `src/channels`, `src/roles`, `src/permissions`, `src/invites` | servers, channels, roles and permissions |
| `src/messages`, `src/attachments`, `src/embeds`, `src/emojis` | chat, files, link previews and GIFs, server emojis |
| `src/voice`, `src/voice-nodes`, `src/sounds` | LiveKit tokens, extra voice servers, soundboard |
| `src/realtime` | Socket.IO gateway and events |
| `src/client-version` | desktop version policy and `GET /api/v1/client/config` |
| `prisma/` | schema and the base migration |
| `docker-compose.yml`, `docker/` | production containers (PostgreSQL, backend, LiveKit) |
| `scripts/` | backups and restore |

Settings are documented in [`.env.example`](.env.example).

## License

AGPL-3.0 — see [`LICENSE`](../LICENSE).
