# FAQ

[Back to README](../../README.md) · [Русский](../ru/faq.md)

**Does AIDis depend on the authors in any way?**
No. There is no central server, account or license check. Your VPS runs everything; the desktop app
updates from GitHub Releases (or from your own mirror).

**How many people can it hold?**
It is built for friend groups and small communities: dozens of people, around ten talking at once on
a 2 GB VPS. More people need a bigger VPS; voice can be spread over extra voice servers.

**Can people use it on phones?**
Yes, in the browser (Chrome, Safari). On iPhone and Android it can be added to the home screen and
behaves like an app. There is no separate mobile app.

**Is it end-to-end encrypted?**
No. Traffic is encrypted between people and your server (HTTPS, DTLS/SRTP for media), and the server
is yours. Whoever controls the VPS can read the database.

**Several communities on one AIDis?**
Yes. One AIDis holds many servers (like guilds), each with its own channels, roles and invites.
Accounts are shared across them.

**Can I use my own domain for the desktop app?**
The app is universal: everyone types their server address. If you want your own branded builds, see
[Your own app builds](build-your-own-app.md).

**Where are GIFs and Steam covers?**
Off by default, because they send requests to third parties. Turn them on in `Server/.env`
(`GIF_PROVIDER`, `GIF_API_KEY`, `STEAM_ART=true`) and run `docker compose up -d` in `Server/`.

**Does it collect any statistics?**
No. Nothing is sent anywhere unless you turn on a third-party feature.

**Can I run it without Docker?**
Possible for developers (see [Server/README.md](../../Server/README.md)), but the installer and the
updater expect Docker.
