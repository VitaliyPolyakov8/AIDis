# Установка

[К README](../../README.ru.md) · [English](../en/install.md)

Перед началом нужны VPS и DNS-записи, как описано в [Требованиях](requirements.md). В примерах —
`chat.example.com`; пишите свой домен.

## 1. Подключитесь к VPS

```bash
ssh root@chat.example.com
```

(Имя пользователя и пароль или ключ даёт хостер. Если вы не `root`, добавляйте `sudo` перед
командами ниже.)

## 2. Скачайте AIDis

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/OWNER/AIDis /opt/aidis
```

`/opt/aidis` — удобное место, но подойдёт любая папка. Всё, что пишет AIDis, остаётся в ней и в
томах Docker.

## 3. Запустите установщик

```bash
sudo bash /opt/aidis/deploy/setup.sh
```

Он задаст три вопроса:

```
Domain of this AIDis (for example chat.example.com): chat.example.com
E-mail for Let's Encrypt certificate notices: you@example.com
Voice and video calls on this VPS? (yes/no) [yes]: yes
```

Дальше он работает сам 5-15 минут (больше всего времени — сборка на маленьком VPS):

1. проверяет, что домен указывает на этот VPS, и предупреждает, если нет;
2. ставит Docker из официального репозитория, если его нет;
3. проверяет, какие порты свободны (см. ниже), и выбирает Caddy или уже установленный nginx;
4. пишет `Server/.env` со случайными секретами (только один раз: при повторном запуске они
   сохраняются);
5. собирает веб-клиент и сервер;
6. запускает PostgreSQL, сервер, LiveKit (голос) и Caddy;
7. ждёт, пока ответит `https://chat.example.com/health`.

В конце вы увидите:

```
------------------------------------------------------------------
AIDis: https://chat.example.com
DNS (A records pointing at this VPS): chat.example.com, rtc.chat.example.com
Open in the firewall of your VPS provider: 80/tcp, 443/tcp, 17881/tcp, 50000-50100/udp, 13478/udp

Finish the setup in a browser (administrator, first server, registration):
  https://chat.example.com/setup?code=Kq7mPz3xWv9rTb2nHs8dLc4f
------------------------------------------------------------------
```

Откройте порты из этой строки в файрволе хостера (если он есть) и откройте ссылку. Дальше —
[Первый запуск](first-run.md).

Потеряли вывод? `sudo bash /opt/aidis/deploy/setup.sh --print` покажет его снова.

## Без вопросов

Все ответы можно передать параметрами, например в своих скриптах:

```bash
sudo bash /opt/aidis/deploy/setup.sh --domain chat.example.com --email you@example.com --voice yes
```

| Параметр | Значение |
| --- | --- |
| `--domain ИМЯ` | домен этого AIDis |
| `--email АДРЕС` | сюда Let's Encrypt пишет о сертификатах |
| `--voice yes\|no` | запускать ли голос (LiveKit) на этом VPS |
| `--proxy auto\|caddy\|nginx` | кто обслуживает HTTPS; `auto` решает по портам |
| `--udp-range 50000-50100` | UDP-порты для звука и видео |
| `--print` | показать итог и ссылку настройки снова |

## Занятые порты

Установщик никогда не останавливает чужие программы. Перед запуском он проверяет:

- **80 и 443.** Свободны — HTTPS обслуживает маленький контейнер Caddy и сам продлевает
  сертификаты. Заняты nginx — AIDis добавляется в этот nginx отдельным сайтом, сертификат получает
  certbot (остальные ваши сайты продолжают работать). Заняты чем-то другим (Apache, другой прокси) —
  установщик останавливается и пишет об этом; см. [Свой веб-сервер](#свой-веб-сервер).
- **Порты сервера и голоса** (18080, 17880, 17881 TCP; 13478 UDP). Если порт занят, берётся
  следующий свободный (`17881` -> `17891` -> ...), итоговый список печатается в конце.
- **UDP-диапазон 50000-50100.** Если внутри него уже что-то слушает, установщик остановится и
  предложит другой диапазон: запустите его снова с `--udp-range 40000-40100`.

## VPS, где уже есть nginx

Ничего дополнительно делать не нужно: установщик видит nginx на портах 80/443, добавляет
`/etc/nginx/sites-available/aidis-chat.example.com`, проверяет его `nginx -t` (сломанный конфиг
сразу удаляется, nginx не перезагружается), перезагружает nginx и запускает
`certbot --nginx -d chat.example.com -d rtc.chat.example.com`. Если в nginx уже есть сайт с тем же
доменом, установщик остановится: уберите тот сайт или выделите AIDis другой (под)домен.

## Свой веб-сервер

Если порты 80/443 принадлежат не nginx (Apache, Traefik, панель хостинга), проще всего взять для
AIDis отдельный небольшой VPS. Если нужно уместиться на этом, автоматики нет; администратор,
знакомый с той программой, сделает так:

1. Запишите настройки, ничего не запуская (файл сайта с вашими портами появится как
   `Server/nginx-site.conf`):

   ```bash
   cd /opt/aidis
   sudo bash deploy/setup.sh --proxy nginx --dry-run --dir /opt/aidis/Server --domain chat.example.com --email you@example.com --voice yes
   ```

2. Соберите веб-клиент и запустите AIDis:

   ```bash
   sudo docker run --rm -v /opt/aidis/Client:/src -w /src node:24-bookworm-slim sh -c 'npm ci && npm run build'
   sudo cp -a /opt/aidis/Client/dist/. /opt/aidis/Server/web/
   cd /opt/aidis/Server && sudo docker compose up -d --build
   ```

3. Повторите в своём веб-сервере то, что делает `Server/nginx-site.conf`: `/api/`, `/socket.io/`
   (WebSocket, длинные таймауты), `/health`, `/ready` — на порт бэкенда; все остальные пути отдают
   `/opt/aidis/Server/web`, а для неизвестных — `index.html`; `rtc.chat.example.com` (WebSocket) — на
   порт LiveKit. HTTPS для обоих имён — средствами этой программы.
4. `cat /opt/aidis/Server/config/setup-code` даст код для `https://chat.example.com/setup`.

## Повторный запуск

Запускать `setup.sh` повторно безопасно, и так же меняются ответы (например, `--voice no` или новый
домен): секреты, пароль базы, ключи LiveKit, загруженные файлы и база сохраняются. На время
перенастройки AIDis ненадолго останавливается (около минуты), чтобы его собственные порты не
считались занятыми.

## Что где лежит

| Путь | Что там |
| --- | --- |
| `/opt/aidis/Server/.env` | все настройки и секреты (никому не показывайте; `chmod 600`) |
| `/opt/aidis/Server/install.env` | ответы установщика (домен, прокси, голос) |
| `/opt/aidis/Server/config/client-version.json` | правила версий приложения ([Обновление](updating.md)) |
| `/opt/aidis/Server/config/setup-code` | одноразовый код мастера первого запуска |
| `/opt/aidis/Server/backups/` | резервные копии ([Резервные копии](backups.md)) |
| Тома Docker `aidis_pgdata`, `aidis_uploads` | база данных и загруженные файлы |

Полезные команды (в `/opt/aidis/Server`):

```bash
sudo docker compose ps                     # что запущено
sudo docker compose logs --tail 100 backend
sudo docker compose restart backend
```
