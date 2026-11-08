# Troubleshooting

[Back to README](../../README.md) · [Русский](../ru/troubleshooting.md)

Most answers start with the logs. In `/opt/aidis/Server`:

```bash
sudo docker compose ps
sudo docker compose logs --tail 100 backend
sudo docker compose logs --tail 100 livekit
sudo docker compose logs --tail 100 caddy        # only when Caddy serves HTTPS
```

## Installation

| You see | Do this |
| --- | --- |
| `WARNING: chat.example.com points to 'nothing'` | The DNS record is missing or not visible yet. Create the A record, wait, check with `getent hosts chat.example.com`, run the installer again. |
| `Ports 80/443 are used by 'apache2' ... not by nginx` | Another web server owns the ports. See [Your own web server](install.md#your-own-web-server). |
| `Ports 80/443 are busy ... Caddy cannot start` | You forced `--proxy caddy` while nginx runs. Leave out `--proxy` (auto) or use `--proxy nginx`. |
| `LiveKit TCP port 17881 is used by 'docker-proxy', using 17891 instead` | Not an error: another program has that port. Open the new port (from the summary) in the provider firewall. |
| `UDP ports in 50000-50100 are already used` | Another voice server runs here. Run again with `--udp-range 40000-40100`. |
| `nginx already has a site for chat.example.com` | Remove that site from `/etc/nginx/sites-enabled/` or give AIDis another (sub)domain. |
| `certbot failed` | Port 80 must be reachable from the internet and both DNS records must point here. Fix, run the installer again. |
| `The web client did not build` | Usually too little memory. Add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`, run again. |
| `https://chat.example.com does not answer yet` | Wait a minute and open it again; check `docker compose ps` and the backend logs. |

## The site and the apps

| You see | Do this |
| --- | --- |
| The browser says the page is "not responding" or times out | The provider firewall blocks 80/443, or the containers are down (`docker compose ps`). |
| "Set up AIDis" appears although you finished it | Another domain or an old browser tab; reload. The wizard shows only while no administrator exists. |
| The setup code is "wrong" | Copy it again: `sudo cat /opt/aidis/Server/config/setup-code`. |
| The desktop app: "A site opens at this address, but it is not AIDis" | The domain points at another site; check DNS and the address. |
| The desktop app: "The server does not answer" | Open the address in a browser on the same PC. If it works there, a firewall on the PC blocks the app. |
| Registration is not offered | Mail is not checked with a test letter yet, or the mode is "Off" ([Mail and registration](mail-and-registration.md)). |

## Voice

| You see | Do this |
| --- | --- |
| Ping shows "calculating" | Normal while you are alone with the microphone off: there is no audio to measure. |
| Joining a call hangs on "connecting" | `rtc.chat.example.com` is missing in DNS, or LiveKit is not running (`docker compose ps`; voice on?). |
| Connected, but nobody hears anybody | UDP 50000-50100 and TCP 17881 are closed in the provider firewall. Open the ports from the installer summary. |
| Works at home, not at work or on mobile data | Open UDP 13478 (TURN) in the provider firewall. |
| An extra voice server cannot be added | Its domain must be a subdomain of your AIDis domain, and its `https://` address must open in a browser. |
| A game does not react to push-to-talk | The game runs as administrator: start AIDis as administrator too. |

## Still stuck

Collect `docker compose ps`, the last 100 lines of the backend log and what you did, and open an issue
on GitHub. Remove domains, IP addresses and e-mails you do not want to publish.
