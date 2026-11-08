# LiveKit configuration

There is intentionally no `livekit.yaml` file here. The LiveKit server reads its whole
configuration from the `LIVEKIT_CONFIG` environment variable, which
`docker-compose.yml` builds from the values in `.env`. That way every port lives in
one place (`.env`) and cannot drift out of sync with the Compose port mappings.

API credentials are passed separately via `LIVEKIT_KEYS` (`<key>: <secret>`), built from
`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

To see the exact configuration LiveKit will receive (RUN ON LINUX MINI-PC):

```bash
docker compose config livekit
```

Note: that output contains your secrets; do not paste it anywhere public.

Port model (all numbers come from `.env`):

| Purpose | Container | Host | Exposure |
|---|---|---|---|
| Signaling HTTP/WebSocket | 7880 | `LIVEKIT_HOST_BIND:LIVEKIT_HOST_PORT` | localhost only, proxied by host Nginx as `wss://rtc.<your domain>` (own server block, shared port 443) |
| ICE over TCP | `LIVEKIT_RTC_TCP_PORT` | same number | public (router forward) |
| RTC media (UDP range) | `LIVEKIT_RTC_PORT_START`-`END` | same numbers | public (router forward) |
| TURN/UDP | `TURN_UDP_HOST_PORT` | same number | public (router forward) |
| TURN/TLS (optional overlay) | `TURN_TLS_HOST_PORT` | same number | public (router forward) |
| TURN relay -> SFU | `TURN_RELAY_PORT_START`-`END` | not published | internal to the container |

WebRTC advertises the port it listens on inside the container to clients, so media
and TURN ports must use the same number on both sides of the mapping.

See `DEPLOYMENT.md`, sections 23 (LiveKit) and 24 (TURN).
