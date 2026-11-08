# Voice

[Back to README](../../README.md) · [Русский](../ru/voice.md)

## How it works

Voice, video and screen sharing go through **LiveKit**, an open-source media server, running on your
VPS next to AIDis. The browser or app connects to `wss://rtc.chat.example.com` to join a call and
then sends audio and video over UDP (ports 50000-50100) or, on networks that block UDP, over TCP
(17881). People behind a very strict NAT use the built-in TURN relay (UDP 13478). Nobody else is
involved: calls never leave your server.

The installer sets all of this up with `--voice yes` (the default). The final summary lists the
ports; they must be open in your VPS provider's firewall.

## Turning voice on or off later

```bash
sudo bash /opt/aidis/deploy/setup.sh --voice yes     # or --voice no
```

With voice off, LiveKit does not run and the voice ports are not needed; its keys stay in
`Server/.env` for later. For voice on, the DNS record `rtc.chat.example.com` must exist.

## Checking a call

- Join a voice channel with a second account (another browser or a phone) and talk.
- The signal bars next to your name show the connection; hover them for the ping.
- **Ping shows "calculating" while you are alone with the microphone off**: the statistics come from
  audio streams, and there are none yet. Unmute or let someone join.

## Extra voice servers

Friends far away from your VPS get a long delay. Rent a small VPS closer to them and put only voice
there:

1. DNS: `voice2.chat.example.com` -> the new VPS. **It must be a subdomain of your AIDis domain**
   (the apps only allow voice servers under it).
2. Copy `voice-node/install.sh` from this repository to the new VPS and run:

   ```bash
   sudo bash install.sh --domain voice2.chat.example.com --email you@example.com
   ```

   It works like the main installer: Caddy on a clean VPS, the existing nginx otherwise, busy ports
   moved. At the end it prints three lines (URL, API key, API secret).
3. In AIDis: **Settings -> Administration -> Voice servers -> Add a voice server**, paste the three lines.
4. Move a voice channel there: channel settings -> **Voice server**.

`sudo bash install.sh --print` shows the three lines again; `--uninstall` removes the node.
Open on that VPS: 80/tcp and 443/tcp (only with Caddy), 7881/tcp (or the port it chose) and
50000-60000/udp.

## Quality

Screen sharing presets (720p30 to 1440p60) are chosen by the person who shares. The VPS needs upload
bandwidth of roughly 2-6 Mbit/s per viewer for 1080p. Audio is light: about 50 kbit/s per speaker
per listener.
