# Backups

[Back to README](../../README.md) · [Русский](../ru/backups.md)

Everything that matters is in three places:

| What | Where |
| --- | --- |
| Database (accounts, servers, messages) | Docker volume `aidis_pgdata` |
| Uploaded files (attachments, avatars, emojis, sounds) | Docker volume `aidis_uploads` |
| Settings and secrets | `/opt/aidis/Server/.env`, `/opt/aidis/Server/config/` |

## Make a backup

```bash
cd /opt/aidis/Server
sudo ./scripts/backup-all.sh
```

AIDis keeps running. The result is two files in `/opt/aidis/Server/backups`:
`aidis-db-<date>.dump` and `aidis-uploads-<date>.tar.gz`. `deploy/update.sh` makes one before every
update.

**Copy the backups off the VPS** (a backup that dies with the VPS does not help), together with
`.env` and `config/`. For example, from your computer:

```bash
scp -r root@chat.example.com:/opt/aidis/Server/backups ./aidis-backups
scp root@chat.example.com:/opt/aidis/Server/.env ./aidis-backups/env
```

## Every night

```bash
sudo crontab -e
```

and add (03:30 every night, keeps 14 days):

```
30 3 * * * cd /opt/aidis/Server && BACKUP_KEEP_DAYS=14 ./scripts/backup-all.sh >> backups/cron.log 2>&1
```

## Restore

```bash
cd /opt/aidis/Server
sudo ./scripts/restore-db.sh backups/aidis-db-20260101-033000.dump
sudo ./scripts/restore-uploads.sh backups/aidis-uploads-20260101-033000.tar.gz
```

`restore-db.sh` asks you to type `RESTORE`, makes a fresh backup of the current database first,
stops only the backend while it restores (all or nothing) and starts it again.

## Moving to another VPS

1. On the old VPS: make a backup and copy `backups/`, `.env` and `config/` to your computer.
2. Point the DNS records at the new VPS.
3. On the new VPS: `git clone` as in [Installation](install.md), then put the old `.env` into
   `/opt/aidis/Server/.env` and the old `config/` into `/opt/aidis/Server/config/` **before** running
   `setup.sh` (so the same secrets are used), then run `setup.sh`.
4. Copy the backup files into `/opt/aidis/Server/backups/` and restore them as above.
