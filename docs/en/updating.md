# Updating

[Back to README](../../README.md) · [Русский](../ru/updating.md)

## The server

```bash
sudo bash /opt/aidis/deploy/update.sh
```

What it does, in this order:

1. **Backup** of the database and uploaded files into `Server/backups` (skip with `--no-backup`, not
   recommended).
2. `git pull` of the newest version. If nothing changed, it stops here (`--rebuild` forces a
   rebuild anyway).
3. Builds the web client and the server while the old version keeps running.
4. Runs the **database migrations**. If one fails, nothing is restarted: the old version keeps
   running and the script prints how to go back (the commit to return to and the backup to restore).
5. Restarts with the new version and waits until `https://chat.example.com/health` answers.

People see a short reconnect (seconds). Read the release notes on GitHub before big version jumps.

If `git pull` complains about local changes, someone edited files in `/opt/aidis` by hand. Your
settings live in `Server/.env` and `Server/config/`, which git does not track, so normally there is
nothing to lose: `git -C /opt/aidis status` shows what changed.

## Changing settings

Edit `/opt/aidis/Server/.env` (every setting is described in `Server/.env.example`), then:

```bash
cd /opt/aidis/Server && sudo docker compose up -d
```

To change the domain, voice or ports, run `deploy/setup.sh` again instead ([Installation](install.md#running-it-again)).

## Desktop app versions

The apps of your users update themselves from GitHub Releases. The file
`/opt/aidis/Server/config/client-version.json` lets you steer them:

```json
{
  "desktop": {
    "latestVersion": "1.0.0",
    "minimumVersion": "1.0.0",
    "downloadUrl": "",
    "mandatory": false,
    "releaseNotes": [],
    "updateMirrorUrl": ""
  }
}
```

- `minimumVersion`: older apps are asked to update before they connect. Raise it when a server
  update needs a newer app (the release notes say so).
- `updateMirrorUrl`: an `https://` folder with `latest.yml`, `AIDis-Setup-<version>.exe` and its
  `.blockmap` from a release; apps connected to this server update from there instead of GitHub
  (useful where GitHub is slow or blocked).

The server re-reads the file by itself; no restart needed.
