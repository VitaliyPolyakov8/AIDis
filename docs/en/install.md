# Installation

[Back to README](../../README.md) · [Русский](../ru/install.md)

Before you start: a VPS and DNS records as described in [Requirements](requirements.md). The
examples use `chat.example.com`; write your own domain instead.

## 1. Connect to the VPS

```bash
ssh root@chat.example.com
```

(Use the user name and password or key your provider gave you. With a non-root user, put `sudo`
before the commands below.)

## 2. Get AIDis

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/VitaliyPolyakov8/AIDis /opt/aidis
```

`/opt/aidis` is a good place; any folder works. Everything AIDis writes stays inside it and in Docker
volumes.

## 3. Run the installer

```bash
sudo bash /opt/aidis/deploy/setup.sh
```

It asks three questions:

```
Domain of this AIDis (for example chat.example.com): chat.example.com
E-mail for Let's Encrypt certificate notices: you@example.com
Voice and video calls on this VPS? (yes/no) [yes]: yes
```

Then it works on its own for 5-15 minutes (most of it is building on a small VPS):

1. checks that the domain points at this VPS and warns if not;
2. installs Docker from the official repository if it is missing;
3. checks which ports are free (see below) and chooses Caddy or the nginx that is already there;
4. writes `Server/.env` with random secrets (only once: running it again keeps them);
5. builds the web client and the server;
6. starts PostgreSQL, the server, LiveKit (voice) and Caddy;
7. waits until `https://chat.example.com/health` answers.

At the end you see:

```
------------------------------------------------------------------
AIDis: https://chat.example.com
DNS (A records pointing at this VPS): chat.example.com, rtc.chat.example.com
Open in the firewall of your VPS provider: 80/tcp, 443/tcp, 17881/tcp, 50000-50100/udp, 13478/udp

Finish the setup in a browser (administrator, first server, registration):
  https://chat.example.com/setup?code=Kq7mPz3xWv9rTb2nHs8dLc4f
------------------------------------------------------------------
```

Open the ports from that line in your provider's firewall, if it has one, and open the link. Go on
with [First run](first-run.md).

Lost the output? `sudo bash /opt/aidis/deploy/setup.sh --print` shows it again.

## Without questions

All answers can be given as options, for example in your own scripts:

```bash
sudo bash /opt/aidis/deploy/setup.sh --domain chat.example.com --email you@example.com --voice yes
```

| Option | Meaning |
| --- | --- |
| `--domain NAME` | the domain of this AIDis |
| `--email ADDRESS` | Let's Encrypt sends certificate notices there |
| `--voice yes\|no` | run voice (LiveKit) on this VPS |
| `--proxy auto\|caddy\|nginx` | who serves HTTPS; `auto` decides by the ports |
| `--udp-range 50000-50100` | UDP ports for voice media |
| `--print` | show the summary and the setup link again |

## Busy ports

The installer never stops other programs. Before starting anything it checks:

- **80 and 443.** Free: a small Caddy container serves HTTPS and renews the certificates itself.
  Used by nginx: AIDis is added to that nginx as a new site and certbot gets the certificate (your
  other sites keep working). Used by anything else (Apache, another proxy): the installer stops and
  says so; see [Your own web server](#your-own-web-server).
- **Ports of the server and voice** (18080, 17880, 17881 TCP; 13478 UDP). If one is used, the next
  free one is taken (`17881` -> `17891` -> ...) and the final list is printed.
- **The UDP range 50000-50100.** If something already listens inside it, the installer stops and
  suggests another range: run it again with `--udp-range 40000-40100`.

## A VPS that already runs nginx

Nothing extra to do: the installer finds nginx on ports 80/443, adds
`/etc/nginx/sites-available/aidis-chat.example.com`, checks it with `nginx -t` (a broken config is
removed again and nginx is not reloaded), reloads nginx and runs
`certbot --nginx -d chat.example.com -d rtc.chat.example.com`. If nginx already has a site for the
same domain, the installer stops: remove that site or use another (sub)domain for AIDis.

## Your own web server

When ports 80/443 belong to something that is not nginx (Apache, Traefik, another panel), the
simplest way is a separate small VPS for AIDis. If it has to share this one, this is not automated;
an administrator who knows that program can do it:

1. Write the configuration without starting anything (the site file for your ports appears as
   `Server/nginx-site.conf`):

   ```bash
   cd /opt/aidis
   sudo bash deploy/setup.sh --proxy nginx --dry-run --dir /opt/aidis/Server --domain chat.example.com --email you@example.com --voice yes
   ```

2. Build the web client and start AIDis:

   ```bash
   sudo docker run --rm -v /opt/aidis/Client:/src -w /src node:24-bookworm-slim sh -c 'npm ci && npm run build'
   sudo cp -a /opt/aidis/Client/dist/. /opt/aidis/Server/web/
   cd /opt/aidis/Server && sudo docker compose up -d --build
   ```

3. Repeat what `Server/nginx-site.conf` does in your web server: `/api/`, `/socket.io/` (WebSocket,
   long timeouts), `/health`, `/ready` go to the backend port; every other path serves
   `/opt/aidis/Server/web` with `index.html` for unknown paths; `rtc.chat.example.com` (WebSocket)
   goes to the LiveKit port. Add HTTPS for both names the way that program does it.
4. `cat /opt/aidis/Server/config/setup-code` gives the code for `https://chat.example.com/setup`.

## Running it again

Running `setup.sh` again is safe and is the way to change answers (for example `--voice no` or a new
domain): secrets, the database password, the LiveKit keys, uploaded files and the database stay. It
briefly stops AIDis (about a minute) so its own ports are not reported as busy.

## What is where

| Path | Content |
| --- | --- |
| `/opt/aidis/Server/.env` | all settings and secrets (keep it private; `chmod 600`) |
| `/opt/aidis/Server/install.env` | the installer's answers (domain, proxy, voice) |
| `/opt/aidis/Server/config/client-version.json` | the desktop app version policy ([Updating](updating.md)) |
| `/opt/aidis/Server/config/setup-code` | the one-time code of the first-run wizard |
| `/opt/aidis/Server/backups/` | backups ([Backups](backups.md)) |
| Docker volumes `aidis_pgdata`, `aidis_uploads` | the database and uploaded files |

Useful commands (run in `/opt/aidis/Server`):

```bash
sudo docker compose ps                     # what runs
sudo docker compose logs --tail 100 backend
sudo docker compose restart backend
```
