# Security

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private reporting instead:
the repository's **Security** tab -> **Report a vulnerability**. Describe what an attacker can do, how
to reproduce it and which version you tested. You get an answer as soon as a maintainer can look at
it; fixes are released as a new version with a note in the release.

## Supported versions

Only the newest release gets security fixes. Update with `deploy/update.sh` ([guide](docs/en/updating.md)).

## How AIDis is built to be safe

- Passwords are hashed with Argon2; sessions use short-lived access tokens and rotating refresh
  tokens that can be revoked per device.
- Secrets (JWT key, database password, LiveKit keys, the SMTP password) are generated per
  installation, kept in `Server/.env` (`chmod 600`) or encrypted in the database, and never returned
  by the API.
- PostgreSQL is reachable only on an internal Docker network; the backend and LiveKit signaling
  listen on localhost behind the HTTPS proxy.
- The first-run wizard needs a one-time code that exists only on the server, and works exactly once.
- Link previews and the image proxy refuse private and reserved network addresses (no SSRF into your
  network).
- Third-party features (GIF search, Steam covers) are off by default; there is no telemetry.
- The desktop app runs the UI sandboxed with a strict Content-Security-Policy built for the chosen
  server, exposes a small validated bridge, connects only over https and stores logins encrypted
  with Windows DPAPI.

## For server owners

- Keep the VPS updated (`sudo apt-get upgrade`, or unattended upgrades) and AIDis updated.
- Use SSH keys, not passwords, for the VPS.
- Keep backups off the VPS ([Backups](docs/en/backups.md)); `.env` in a backup is a secret.
- Whoever has root on the VPS can read everything in AIDis. Choose your hosting accordingly.
