#!/usr/bin/env bash
# AIDis voice node: installs LiveKit (the same version as the main AIDis server) with HTTPS on an
# Ubuntu 22.04 / 24.04 VPS and prints the three lines to paste into
# AIDis -> Settings -> Administration -> Voice servers -> Add.
#
#   sudo bash install.sh --domain voice2.chat.example.com --email you@example.com
#   sudo bash install.sh --print        (show the three lines again)
#   sudo bash install.sh --uninstall
#
# HTTPS: on a clean VPS a small Caddy container gets the certificate. When nginx already serves
# ports 80/443 (other sites on this VPS), the node is added to that nginx and certbot issues the
# certificate (--proxy auto, the default; force with --proxy caddy | nginx).
# Busy ports are detected before anything starts: the LiveKit TCP port moves to a free one by itself
# (or set --rtc-tcp-port N); --port N (LiveKit HTTP, default 7880), --udp-range A-B (default 50000-60000).
# Running it again keeps the API key and secret and the chosen ports (saved in /opt/aidis-voice/install.env).
# --dry-run --dir <folder>: only writes the files into <folder> and prints the block (for testing).
set -euo pipefail

LIVEKIT_IMAGE="livekit/livekit-server:v1.13.7"
CADDY_IMAGE="caddy:2.8.4"
DIR="/opt/aidis-voice"
DOMAIN=""
EMAIL=""
MODE="install"
DRY_RUN=0
PROXY=""
HTTP_PORT=""
RTC_TCP_PORT=""
UDP_RANGE=""
EXPLICIT_HTTP=0
EXPLICIT_TCP=0

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
note() { echo "NOTE: $*"; }

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --port) HTTP_PORT="${2:-}"; EXPLICIT_HTTP=1; shift 2 ;;
    --rtc-tcp-port) RTC_TCP_PORT="${2:-}"; EXPLICIT_TCP=1; shift 2 ;;
    --udp-range) UDP_RANGE="${2:-}"; shift 2 ;;
    --uninstall) MODE="uninstall"; shift ;;
    --print) MODE="print"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

CONFIG="$DIR/livekit.yaml"
STATE="$DIR/install.env"
COMPOSE="$DIR/docker-compose.yml"

# ---- saved settings (install.env), or what an older install left in livekit.yaml / docker-compose.yml ----
S_DOMAIN="" S_EMAIL="" S_PROXY="" S_HTTP_PORT="" S_TCP_PORT="" S_UDP_RANGE="" S_NGINX_SITE="" S_NGINX_CREATED=""
load_state() {
  if [ -f "$STATE" ]; then
    local k v
    while IFS='=' read -r k v; do
      case "$k" in
        DOMAIN) S_DOMAIN="$v" ;;
        EMAIL) S_EMAIL="$v" ;;
        PROXY) S_PROXY="$v" ;;
        HTTP_PORT) S_HTTP_PORT="$v" ;;
        RTC_TCP_PORT) S_TCP_PORT="$v" ;;
        UDP_RANGE) S_UDP_RANGE="$v" ;;
        NGINX_SITE) S_NGINX_SITE="$v" ;;
        NGINX_CREATED) S_NGINX_CREATED="$v" ;;
      esac
    done <"$STATE"
    return 0
  fi
  if [ -f "$CONFIG" ]; then
    S_HTTP_PORT="$(awk '/^port:/{print $2; exit}' "$CONFIG")"
    S_TCP_PORT="$(awk '/^  tcp_port:/{print $2; exit}' "$CONFIG")"
    local a b
    a="$(awk '/^  port_range_start:/{print $2; exit}' "$CONFIG")"
    b="$(awk '/^  port_range_end:/{print $2; exit}' "$CONFIG")"
    if [ -n "$a" ] && [ -n "$b" ]; then S_UDP_RANGE="$a-$b"; fi
  fi
  if [ -f "$COMPOSE" ]; then
    if grep -q '^  caddy:' "$COMPOSE"; then S_PROXY="caddy"; else S_PROXY="nginx"; fi
  fi
  if [ -f "$DIR/Caddyfile" ]; then
    S_DOMAIN="$(awk 'NF && $1 !~ /^[{}#]/ && $1 !~ /^email$/ && $2 == "{" {print $1; exit}' "$DIR/Caddyfile")"
    S_EMAIL="$(awk '$1 == "email" {print $2; exit}' "$DIR/Caddyfile")"
  fi
  return 0
}

# The API key / secret already written into livekit.yaml ("keys:" then "  KEY: SECRET").
API_KEY="" API_SECRET=""
read_keys() {
  [ -f "$CONFIG" ] || return 1
  local line
  line="$(awk '/^keys:/{getline; print; exit}' "$CONFIG")"
  API_KEY="$(echo "$line" | sed -nE 's/^[[:space:]]*([A-Za-z0-9]+):[[:space:]]*([A-Za-z0-9]+)[[:space:]]*$/\1/p')"
  API_SECRET="$(echo "$line" | sed -nE 's/^[[:space:]]*([A-Za-z0-9]+):[[:space:]]*([A-Za-z0-9]+)[[:space:]]*$/\2/p')"
  [ -n "$API_KEY" ] && [ -n "$API_SECRET" ]
}

random_string() {
  # Letters and digits only (safe in YAML and when pasted).
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true
}

print_block() {
  echo
  echo "Paste these three lines into AIDis -> Administration -> Voice servers -> Add:"
  echo "------------------------------------------------------------------"
  echo "URL: wss://$DOMAIN"
  echo "API key: $API_KEY"
  echo "API secret: $API_SECRET"
  echo "------------------------------------------------------------------"
}

# ---- ports ------------------------------------------------------------------------------------------
# Tests can describe busy ports instead of asking ss: AIDIS_FAKE_TCP="80:nginx 443:nginx 7881:docker-proxy",
# AIDIS_FAKE_UDP="7882 50005".
tcp_owner() {
  local e line name
  if [ -n "${AIDIS_FAKE_TCP+x}" ]; then
    for e in $AIDIS_FAKE_TCP; do
      if [ "${e%%:*}" = "$1" ]; then echo "${e#*:}"; return 0; fi
    done
    return 0
  fi
  command -v ss >/dev/null 2>&1 || return 0
  line="$(ss -Hltnp "sport = :$1" 2>/dev/null | head -n1 || true)"
  [ -n "$line" ] || return 0
  name="$(echo "$line" | sed -nE 's/.*users:\(\("([^"]+)".*/\1/p')"
  echo "${name:-unknown}"
}

udp_busy_in_range() {
  local p
  if [ -n "${AIDIS_FAKE_UDP+x}" ]; then
    for p in $AIDIS_FAKE_UDP; do
      if [ "$p" -ge "$1" ] && [ "$p" -le "$2" ]; then echo "$p"; fi
    done
    return 0
  fi
  command -v ss >/dev/null 2>&1 || return 0
  ss -Hlun 2>/dev/null | awk '{print $4}' | sed -nE 's/.*:([0-9]+)$/\1/p' | while read -r p; do
    if [ "$p" -ge "$1" ] && [ "$p" -le "$2" ]; then echo "$p"; fi
  done | sort -un
}

valid_port() { echo "$1" | grep -Eq '^[0-9]{4,5}$' && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }

# A free TCP port: the wanted one, or (when it was not set by hand) the next free of 7891, 7901, ...
pick_port() {
  local wanted="$1" explicit="$2" what="$3" avoid="$4" owner candidate
  owner="$(tcp_owner "$wanted")"
  if [ -z "$owner" ] && [ "$wanted" != "$avoid" ]; then echo "$wanted"; return 0; fi
  if [ "$explicit" = 1 ]; then
    die "$what port $wanted is already used by '${owner:-this node}'. Pick another one."
  fi
  for candidate in 7891 7901 7911 7921 7931 7941 7951 7961 7971 7981 7991; do
    if [ "$candidate" != "$avoid" ] && [ -z "$(tcp_owner "$candidate")" ]; then
      echo "NOTE: $what port $wanted is used by '${owner:-this node}', using $candidate instead." >&2
      echo "$candidate"
      return 0
    fi
  done
  die "$what port $wanted is busy and no free port was found among 7891-7991; set one with the flag."
}

nginx_site_for() {
  # The nginx file that already serves this domain (server_name), if any.
  local f pattern
  pattern="server_name[^;]*[[:space:]]$(echo "$1" | sed 's/\./\\./g')[[:space:];]"
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -f "$f" ] || continue
    if grep -Eq "$pattern" "$f"; then
      readlink -f "$f"
      return 0
    fi
  done
  return 0
}

nginx_site_text() {
  cat <<EOF
# AIDis voice node $DOMAIN -> LiveKit on 127.0.0.1:$HTTP_PORT (written by install.sh; certbot adds HTTPS).
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$HTTP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
}

load_state

# ---- --print ------------------------------------------------------------------------------------------
if [ "$MODE" = "print" ]; then
  read_keys || die "No installation found in $DIR"
  DOMAIN="${DOMAIN:-$S_DOMAIN}"
  [ -n "$DOMAIN" ] || die "No domain is saved in $DIR; run with --domain <name> --print"
  print_block
  exit 0
fi

# ---- --uninstall ---------------------------------------------------------------------------------------
if [ "$MODE" = "uninstall" ]; then
  [ "$DRY_RUN" = 1 ] || [ "$(id -u)" = 0 ] || die "Run as root (sudo)."
  if [ "$DRY_RUN" = 0 ] && [ -f "$COMPOSE" ]; then
    info "Stopping the voice node"
    docker compose -f "$COMPOSE" down || true
  fi
  if [ "$S_PROXY" = "nginx" ] && [ "$S_NGINX_CREATED" = 1 ] && [ -n "$S_NGINX_SITE" ]; then
    if [ "$DRY_RUN" = 0 ]; then
      rm -f "/etc/nginx/sites-enabled/$(basename "$S_NGINX_SITE")" "$S_NGINX_SITE"
      nginx -t && systemctl reload nginx
    fi
    info "Removed the nginx site $S_NGINX_SITE (the certificate stays in /etc/letsencrypt)."
  elif [ "$S_PROXY" = "nginx" ]; then
    note "the nginx site for ${S_DOMAIN:-the node} was not created by this script, so it was left as it is."
  fi
  rm -rf "$DIR"
  info "Removed $DIR. Docker, nginx and firewall rules were left as they are."
  exit 0
fi

# ---- install / update --------------------------------------------------------------------------------------
DOMAIN="${DOMAIN:-$S_DOMAIN}"
EMAIL="${EMAIL:-$S_EMAIL}"
[ -n "$DOMAIN" ] || die "--domain is required (for example voice2.chat.example.com)"
[ -n "$EMAIL" ] || die "--email is required (Let's Encrypt sends certificate notices there)"
echo "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' || die "Not a valid domain name: $DOMAIN"
echo "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || die "Not a valid e-mail: $EMAIL"
PROXY="${PROXY:-${S_PROXY:-auto}}"
case "$PROXY" in auto|caddy|nginx) ;; *) die "--proxy must be auto, caddy or nginx" ;; esac
HTTP_PORT="${HTTP_PORT:-${S_HTTP_PORT:-7880}}"
RTC_TCP_PORT="${RTC_TCP_PORT:-${S_TCP_PORT:-7881}}"
UDP_RANGE="${UDP_RANGE:-${S_UDP_RANGE:-50000-60000}}"
valid_port "$HTTP_PORT" || die "--port must be a number 1024-65535"
valid_port "$RTC_TCP_PORT" || die "--rtc-tcp-port must be a number 1024-65535"
echo "$UDP_RANGE" | grep -Eq '^[0-9]{4,5}-[0-9]{4,5}$' || die "--udp-range must look like 50000-60000"
UDP_START="${UDP_RANGE%-*}"
UDP_END="${UDP_RANGE#*-}"
if [ "$UDP_START" -lt 1024 ] || [ "$UDP_END" -gt 65535 ] || [ "$UDP_END" -le "$UDP_START" ]; then die "Bad --udp-range $UDP_RANGE"; fi

if [ "$DRY_RUN" = 0 ]; then
  [ "$(id -u)" = 0 ] || die "Run as root (sudo)."
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || die "This script supports Ubuntu 22.04 / 24.04 only (found ${ID:-unknown})."
  case "${VERSION_ID:-}" in 22.04|24.04) ;; *) note "tested on Ubuntu 22.04 / 24.04, found $VERSION_ID" ;; esac

  # The domain must already point at this VPS (Let's Encrypt checks it).
  PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
  DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)"
  if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "$DOMAIN_IP" ]; then
    echo "WARNING: $DOMAIN points to '${DOMAIN_IP:-nothing}', this VPS is $PUBLIC_IP."
    echo "         Create an A record $DOMAIN -> $PUBLIC_IP first, or the certificate will fail."
  fi

  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    info "Installing Docker (official repository)"
    apt-get update -y
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  # Our own containers must not count as "busy" when this runs again.
  if [ -f "$COMPOSE" ]; then
    info "Stopping the current voice node for the update"
    docker compose -f "$COMPOSE" down || true
  fi
fi

# ---- who serves HTTPS -------------------------------------------------------------------------------------
OWNER80="$(tcp_owner 80)"
OWNER443="$(tcp_owner 443)"
nginx_or_free() { [ -z "$1" ] || [ "$1" = "nginx" ]; }
if [ "$PROXY" = "auto" ]; then
  if [ -z "$OWNER80" ] && [ -z "$OWNER443" ]; then
    PROXY="caddy"
  elif nginx_or_free "$OWNER80" && nginx_or_free "$OWNER443"; then
    PROXY="nginx"
    info "nginx already serves ports 80/443 on this VPS: the node is added to it (certificate via certbot)"
  else
    die "Ports 80/443 are used by '${OWNER80:-free}' / '${OWNER443:-free}', not by nginx. Free them, or put the node behind that program by hand."
  fi
fi
if [ "$PROXY" = "caddy" ] && { [ -n "$OWNER80" ] || [ -n "$OWNER443" ]; }; then
  die "Ports 80/443 are busy ('${OWNER80:-free}' / '${OWNER443:-free}'), Caddy cannot start. With nginx there, use --proxy nginx."
fi
if [ "$PROXY" = "nginx" ] && [ "$DRY_RUN" = 0 ] && ! command -v nginx >/dev/null 2>&1; then
  die "--proxy nginx: nginx is not installed on this VPS."
fi

# ---- LiveKit ports ---------------------------------------------------------------------------------------
HTTP_PORT="$(pick_port "$HTTP_PORT" "$EXPLICIT_HTTP" "LiveKit HTTP" "")"
RTC_TCP_PORT="$(pick_port "$RTC_TCP_PORT" "$EXPLICIT_TCP" "LiveKit TCP" "$HTTP_PORT")"
BUSY_UDP="$(udp_busy_in_range "$UDP_START" "$UDP_END" | tr '\n' ' ')"
if [ -n "${BUSY_UDP// /}" ]; then
  die "UDP ports in $UDP_RANGE are already used (${BUSY_UDP% }). Pick a free range, for example --udp-range 40000-40999."
fi

mkdir -p "$DIR"
if read_keys; then
  info "Keeping the existing API key and secret"
else
  API_KEY="API$(random_string 13)"
  API_SECRET="$(random_string 48)"
fi

info "Writing the configuration to $DIR ($PROXY in front, LiveKit HTTP $HTTP_PORT, TCP $RTC_TCP_PORT, UDP $UDP_RANGE)"
cat >"$CONFIG" <<EOF
# AIDis voice node (LiveKit). Written by install.sh; keys are kept when it runs again.
port: $HTTP_PORT
bind_addresses:
  - 0.0.0.0
rtc:
  tcp_port: $RTC_TCP_PORT
  port_range_start: $UDP_START
  port_range_end: $UDP_END
  use_external_ip: true
keys:
  $API_KEY: $API_SECRET
logging:
  level: info
EOF
chmod 600 "$CONFIG"

if [ "$PROXY" = "caddy" ]; then
  cat >"$DIR/Caddyfile" <<EOF
{
	email $EMAIL
}

$DOMAIN {
	reverse_proxy 127.0.0.1:$HTTP_PORT
}
EOF
  cat >"$COMPOSE" <<EOF
# AIDis voice node: LiveKit behind Caddy (HTTPS on 443, certificate from Let's Encrypt).
services:
  livekit:
    image: $LIVEKIT_IMAGE
    restart: unless-stopped
    network_mode: host
    command: --config /etc/livekit.yaml
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
  caddy:
    image: $CADDY_IMAGE
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
EOF
else
  rm -f "$DIR/Caddyfile"
  cat >"$COMPOSE" <<EOF
# AIDis voice node: LiveKit only; HTTPS for $DOMAIN is served by the nginx of this VPS.
services:
  livekit:
    image: $LIVEKIT_IMAGE
    restart: unless-stopped
    network_mode: host
    command: --config /etc/livekit.yaml
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
EOF
fi

# nginx: reuse the site that already serves this domain, otherwise write our own.
NGINX_SITE=""
NGINX_CREATED=0
if [ "$PROXY" = "nginx" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    NGINX_SITE="$DIR/nginx-site.conf"
    nginx_site_text >"$NGINX_SITE"
    NGINX_CREATED=1
  else
    NGINX_SITE="$(nginx_site_for "$DOMAIN")"
    if [ -n "$NGINX_SITE" ]; then
      info "nginx already has a site for $DOMAIN: $NGINX_SITE (left as it is)"
      grep -q "127.0.0.1:$HTTP_PORT" "$NGINX_SITE" || echo "WARNING: $NGINX_SITE does not proxy to 127.0.0.1:$HTTP_PORT - check its proxy_pass."
      if [ "$S_NGINX_SITE" = "$NGINX_SITE" ]; then NGINX_CREATED="${S_NGINX_CREATED:-0}"; fi
    else
      if [ -d /etc/nginx/sites-available ]; then
        NGINX_SITE="/etc/nginx/sites-available/aidis-voice-$DOMAIN"
      else
        NGINX_SITE="/etc/nginx/conf.d/aidis-voice-$DOMAIN.conf"
      fi
      NGINX_CREATED=1
    fi
  fi
fi

cat >"$STATE" <<EOF
DOMAIN=$DOMAIN
EMAIL=$EMAIL
PROXY=$PROXY
HTTP_PORT=$HTTP_PORT
RTC_TCP_PORT=$RTC_TCP_PORT
UDP_RANGE=$UDP_RANGE
NGINX_SITE=$NGINX_SITE
NGINX_CREATED=$NGINX_CREATED
EOF

if [ "$DRY_RUN" = 1 ]; then
  info "Dry run: configuration written, nothing started"
  print_block
  exit 0
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  info "Opening ports in ufw"
  if [ "$PROXY" = "caddy" ]; then ufw allow 80/tcp; ufw allow 443/tcp; fi
  ufw allow "$RTC_TCP_PORT/tcp"
  ufw allow "$UDP_START:$UDP_END/udp"
else
  WEB_PORTS=""
  if [ "$PROXY" = "caddy" ]; then WEB_PORTS="80, 443, "; fi
  note "ufw is not active. If the VPS provider has its own firewall, open ${WEB_PORTS}$RTC_TCP_PORT/tcp and $UDP_START-$UDP_END/udp there."
fi

if [ "$PROXY" = "caddy" ]; then info "Starting LiveKit and Caddy"; else info "Starting LiveKit"; fi
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d --remove-orphans

if [ "$PROXY" = "nginx" ]; then
  if [ ! -f "$NGINX_SITE" ]; then
    info "Adding $DOMAIN to nginx ($NGINX_SITE)"
    nginx_site_text >"$NGINX_SITE"
    case "$NGINX_SITE" in
      /etc/nginx/sites-available/*) ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/$(basename "$NGINX_SITE")" ;;
    esac
    if ! nginx -t; then
      rm -f "/etc/nginx/sites-enabled/$(basename "$NGINX_SITE")" "$NGINX_SITE"
      die "nginx rejected the new site; it was removed again and nginx was not reloaded."
    fi
    systemctl reload nginx
  fi
  if ! grep -q "ssl_certificate" "$NGINX_SITE"; then
    if ! command -v certbot >/dev/null 2>&1; then
      info "Installing certbot"
      apt-get update -y
      apt-get install -y certbot python3-certbot-nginx
    fi
    info "Getting the certificate for $DOMAIN (certbot)"
    certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos -m "$EMAIL" || echo "WARNING: certbot failed - check that $DOMAIN points to this VPS and port 80 is open."
  fi
fi

info "Waiting for https://$DOMAIN (certificate and LiveKit), up to 3 minutes"
ok=0
for _ in $(seq 1 36); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/")" = "200" ]; then ok=1; break; fi
  sleep 5
done
if [ "$ok" = 1 ]; then
  info "The voice node answers on https://$DOMAIN"
else
  echo "WARNING: https://$DOMAIN does not answer yet. Check DNS and ports, then: docker compose -f $COMPOSE logs"
fi

print_block
