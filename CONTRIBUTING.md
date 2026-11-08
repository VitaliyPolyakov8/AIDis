# Contributing

Thank you for helping. Bug reports, translations, documentation fixes and code are all welcome.

## Reporting a bug

Open an issue with: what you did, what you expected, what happened, the AIDis version (Settings ->
About) and, for server problems, `docker compose ps` and the last lines of `docker compose logs
backend`. Remove domains, IP addresses and e-mails you do not want to publish. Security problems go
through private reporting instead ([SECURITY.md](SECURITY.md)).

## The code

| Folder | What | Stack |
| --- | --- | --- |
| `Server/` | API, realtime, database | Node.js 24, Fastify 5, Prisma 7 (PostgreSQL), Socket.IO, zod |
| `Client/` | the web interface (also inside the desktop app) | React 19, Zustand 5, i18next, Vite, LiveKit |
| `Desktop/` | the Windows app | Electron, electron-builder |
| `deploy/` | installer and updater for a VPS | bash, Docker Compose, Caddy / nginx |
| `voice-node/` | extra voice server installer | bash, LiveKit |

Each folder has its own README with development commands. In short:

```bash
cd Server && npm ci && npm test        # tests run on an in-memory PostgreSQL (PGlite)
cd Client && npm ci && npm test
cd Desktop && npm ci && npm test
bash deploy/tests/setup-dry-run.sh     # installer scenarios, nothing is installed
```

## Rules of the house

- **Tests first** for behavior changes: a test that fails without your change and passes with it.
- `npx tsc` and `npm run lint` stay clean in the folder you touched.
- Formatting: Prettier (`--single-quote --print-width 220`); the existing files show the style.
- **Two languages**: every new interface string goes into both `en` and `ru` (a test checks they
  match). Code, comments and commit messages are in English.
- **No hardcoded installations**: no real domains, IP addresses or personal names in code, tests or
  docs (use `example.com`). `Server/tests/public-guard.test.ts` checks this.
- **Private by default**: features that contact third parties are off until the server owner turns
  them on.
- Shell scripts keep LF line endings and must pass `bash -n`.
- Keep pull requests focused; describe what changes for the person using AIDis.

## License

By contributing you agree that your contribution is licensed under the
[GNU AGPL v3.0](LICENSE), like the rest of AIDis.
