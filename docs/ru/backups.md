# Резервные копии

[К README](../../README.ru.md) · [English](../en/backups.md)

Всё важное лежит в трёх местах:

| Что | Где |
| --- | --- |
| База (аккаунты, серверы, сообщения) | том Docker `aidis_pgdata` |
| Загруженные файлы (вложения, аватары, эмодзи, звуки) | том Docker `aidis_uploads` |
| Настройки и секреты | `/opt/aidis/Server/.env`, `/opt/aidis/Server/config/` |

## Сделать копию

```bash
cd /opt/aidis/Server
sudo ./scripts/backup-all.sh
```

AIDis продолжает работать. Результат — два файла в `/opt/aidis/Server/backups`:
`aidis-db-<дата>.dump` и `aidis-uploads-<дата>.tar.gz`. `deploy/update.sh` делает копию перед каждым
обновлением.

**Уносите копии с VPS** (копия, которая пропадёт вместе с VPS, не поможет), вместе с `.env` и
`config/`. Например, со своего компьютера:

```bash
scp -r root@chat.example.com:/opt/aidis/Server/backups ./aidis-backups
scp root@chat.example.com:/opt/aidis/Server/.env ./aidis-backups/env
```

## Каждую ночь

```bash
sudo crontab -e
```

и добавьте (каждую ночь в 03:30, хранить 14 дней):

```
30 3 * * * cd /opt/aidis/Server && BACKUP_KEEP_DAYS=14 ./scripts/backup-all.sh >> backups/cron.log 2>&1
```

## Восстановление

```bash
cd /opt/aidis/Server
sudo ./scripts/restore-db.sh backups/aidis-db-20260101-033000.dump
sudo ./scripts/restore-uploads.sh backups/aidis-uploads-20260101-033000.tar.gz
```

`restore-db.sh` попросит ввести `RESTORE`, сначала сделает свежую копию текущей базы, на время
восстановления остановит только бэкенд (всё или ничего) и снова его запустит.

## Переезд на другой VPS

1. На старом VPS: сделайте копию и унесите `backups/`, `.env` и `config/` к себе.
2. Направьте DNS-записи на новый VPS.
3. На новом VPS: `git clone`, как в [Установке](install.md), затем положите старый `.env` в
   `/opt/aidis/Server/.env` и старую `config/` в `/opt/aidis/Server/config/` **до** запуска
   `setup.sh` (чтобы использовались те же секреты) и запустите `setup.sh`.
4. Скопируйте файлы копий в `/opt/aidis/Server/backups/` и восстановите их, как выше.
