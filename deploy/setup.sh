#!/usr/bin/env bash
# AIDis installer for an Ubuntu 22.04 / 24.04 VPS with a domain pointing at it.
#
#   git clone https://github.com/<owner>/AIDis /opt/aidis
#   sudo bash /opt/aidis/deploy/setup.sh
#
# It asks for the domain, an e-mail for Let's Encrypt and whether this VPS should also carry voice,
# then: installs Docker (if missing), writes Server/.env with random secrets, gets HTTPS, builds and
# starts everything and prints the link of the first-run wizard. Options instead of questions:
#   --domain chat.example.com --email you@example.com --voice yes|no
#   --proxy auto|caddy|nginx   who serves HTTPS (auto: Caddy on a clean VPS, the existing nginx otherwise)
#   --udp-range 50000-50100    UDP ports for voice media
#   --print                    show the addresses, firewall ports and the wizard link again
# Running it again keeps every secret and the database; busy ports are detected before anything starts.
# --dry-run --dir <folder>: only writes the files into <folder> and prints the summary (for testing).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$REPO/deploy/lib/common.sh"

DIR="$REPO/Server"
DOMAIN=""
EMAIL=""
VOICE=""
PROXY=""
UDP_RANGE=""
DRY_RUN=0
MODE="install"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --voice) VOICE="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --udp-range) UDP_RANGE="${2:-}"; shift 2 ;;
    --print) MODE="print"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

ENV_FILE="$DIR/.env"
STATE="$DIR/install.env"
CONFIG_DIR="$DIR/config"

# ---- saved answers (install.env) ------------------------------------------------------------------------
S_DOMAIN="" S_EMAIL="" S_VOICE="" S_PROXY="" S_WEB_DIR="" S_NGINX_SITE=""
if [ -f "$STATE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      DOMAIN) S_DOMAIN="$v" ;;
      EMAIL) S_EMAIL="$v" ;;
      VOICE) S_VOICE="$v" ;;
      PROXY) S_PROXY="$v" ;;
      WEB_DIR) S_WEB_DIR="$v" ;;
      NGINX_SITE) S_NGINX_SITE="$v" ;;
    esac
  done <"$STATE"
fi

ask() {
  # ask "question" default -> the answer (only when a person is at the keyboard)
  local answer=""
  if [ -t 0 ] && [ "$DRY_RUN" = 0 ]; then
    read -r -p "$1${2:+ [$2]}: " answer
  fi
  echo "${answer:-$2}"
}

DOMAIN="${DOMAIN:-$S_DOMAIN}"
[ -n "$DOMAIN" ] || DOMAIN="$(ask "Domain of this AIDis (for example chat.example.com)" "")"
[ -n "$DOMAIN" ] || die "--domain is required (for example chat.example.com)"
DOMAIN="$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
echo "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' || die "Not a valid domain name: $DOMAIN (write only the name, like chat.example.com)"

print_summary() {
  local code="${1:-}" tcp="" udp=""
  if [ "$VOICE" = yes ]; then
    tcp=", $(env_get "$ENV_FILE" LIVEKIT_RTC_TCP_PORT)/tcp"
    udp="$(env_get "$ENV_FILE" LIVEKIT_RTC_PORT_START)-$(env_get "$ENV_FILE" LIVEKIT_RTC_PORT_END)/udp, $(env_get "$ENV_FILE" TURN_UDP_HOST_PORT)/udp"
  fi
  echo
  echo "------------------------------------------------------------------"
  echo "AIDis: https://$DOMAIN"
  if [ "$VOICE" = yes ]; then
    echo "DNS (A records pointing at this VPS): $DOMAIN, rtc.$DOMAIN"
  else
    echo "DNS (A record pointing at this VPS): $DOMAIN   (voice is off)"
  fi
  echo "Open in the firewall of your VPS provider: 80/tcp, 443/tcp${tcp}${udp:+, $udp}"
  if [ -n "$code" ]; then
    echo
    echo "Finish the setup in a browser (administrator, first server, registration):"
    echo "  https://$DOMAIN/setup?code=$code"
  fi
  echo "------------------------------------------------------------------"
}

setup_needed() {
  # true when the wizard has not been finished yet (or the answer is unknown).
  [ "$DRY_RUN" = 1 ] && return 0
  local body
  body="$(curl -fsS --max-time 10 "https://$DOMAIN/api/v1/setup/status" 2>/dev/null || true)"
  [ -z "$body" ] || echo "$body" | grep -q '"needed":true'
}

# ---- --print --------------------------------------------------------------------------------------------
if [ "$MODE" = "print" ]; then
  [ -f "$ENV_FILE" ] || die "No installation found in $DIR"
  VOICE="${S_VOICE:-yes}"
  code=""
  if setup_needed && [ -f "$CONFIG_DIR/setup-code" ]; then code="$(cat "$CONFIG_DIR/setup-code")"; fi
  print_summary "$code"
  exit 0
fi

EMAIL="${EMAIL:-$S_EMAIL}"
[ -n "$EMAIL" ] || EMAIL="$(ask "E-mail for Let's Encrypt certificate notices" "")"
[ -n "$EMAIL" ] || die "--email is required (Let's Encrypt sends certificate notices there)"
echo "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || die "Not a valid e-mail: $EMAIL"
VOICE="${VOICE:-$S_VOICE}"
[ -n "$VOICE" ] || VOICE="$(ask "Voice and video calls on this VPS? (yes/no)" "yes")"
case "$VOICE" in yes|y|Y|YES) VOICE=yes ;; no|n|N|NO) VOICE=no ;; *) die "--voice must be yes or no" ;; esac
PROXY="${PROXY:-${S_PROXY:-auto}}"
case "$PROXY" in auto|caddy|nginx) ;; *) die "--proxy must be auto, caddy or nginx" ;; esac

if [ "$DRY_RUN" = 0 ]; then
  [ "$(id -u)" = 0 ] || die "Run as root: sudo bash $0"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || die "This script supports Ubuntu 22.04 / 24.04 only (found ${ID:-unknown})."
  case "${VERSION_ID:-}" in 22.04|24.04) ;; *) note "tested on Ubuntu 22.04 / 24.04, found $VERSION_ID" ;; esac

  # The names must already point at this VPS (Let's Encrypt checks them).
  PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
  names="$DOMAIN"
  [ "$VOICE" = no ] || names="$DOMAIN rtc.$DOMAIN"
  for name in $names; do
    ip="$(getent ahostsv4 "$name" | awk '{print $1; exit}' || true)"
    if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "$ip" ]; then
      echo "WARNING: $name points to '${ip:-nothing}', this VPS is $PUBLIC_IP."
      echo "         Create an A record $name -> $PUBLIC_IP first, or the certificate will fail."
    fi
  done

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

  # Our own containers must not count as "busy" when this runs again (data volumes are kept).
  if [ -f "$ENV_FILE" ] && [ -n "$(cd "$DIR" && docker compose ps -q 2>/dev/null || true)" ]; then
    info "Stopping the running AIDis for the reconfiguration (data is kept)"
    (cd "$DIR" && docker compose down)
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
    info "nginx already serves ports 80/443 on this VPS: AIDis is added to it (certificate via certbot)"
  else
    die "Ports 80/443 are used by '${OWNER80:-free}' / '${OWNER443:-free}', not by nginx. Free them, or put AIDis behind that program by hand (docs: install guide, section 'Your own web server')."
  fi
fi
if [ "$PROXY" = "caddy" ] && { [ -n "$OWNER80" ] || [ -n "$OWNER443" ]; }; then
  die "Ports 80/443 are busy ('${OWNER80:-free}' / '${OWNER443:-free}'), Caddy cannot start. With nginx there, use --proxy nginx."
fi
if [ "$PROXY" = "nginx" ] && [ "$DRY_RUN" = 0 ] && ! command -v nginx >/dev/null 2>&1; then
  die "--proxy nginx: nginx is not installed on this VPS."
fi

# ---- ports (the ones from an earlier run first; the backend and LiveKit HTTP listen on localhost only) ----
want() { local v; v="$(env_get "$ENV_FILE" "$1")"; echo "${v:-$2}"; }
BACKEND_PORT="$(pick_tcp_port "$(want BACKEND_HOST_PORT 18080)" 0 "Backend" "")"
LIVEKIT_PORT="$(want LIVEKIT_HOST_PORT 17880)"
RTC_TCP_PORT="$(want LIVEKIT_RTC_TCP_PORT 17881)"
TURN_PORT="$(want TURN_UDP_HOST_PORT 13478)"
UDP_RANGE="${UDP_RANGE:-$(want LIVEKIT_RTC_PORT_START 50000)-$(want LIVEKIT_RTC_PORT_END 50100)}"
echo "$UDP_RANGE" | grep -Eq '^[0-9]{4,5}-[0-9]{4,5}$' || die "--udp-range must look like 50000-50100"
UDP_START="${UDP_RANGE%-*}"
UDP_END="${UDP_RANGE#*-}"
if [ "$UDP_START" -lt 1024 ] || [ "$UDP_END" -gt 65535 ] || [ "$UDP_END" -le "$UDP_START" ]; then die "Bad --udp-range $UDP_RANGE"; fi
if [ "$VOICE" = yes ]; then
  LIVEKIT_PORT="$(pick_tcp_port "$LIVEKIT_PORT" 0 "LiveKit HTTP" "$BACKEND_PORT")"
  RTC_TCP_PORT="$(pick_tcp_port "$RTC_TCP_PORT" 0 "LiveKit TCP" "$BACKEND_PORT $LIVEKIT_PORT")"
  BUSY_UDP="$(udp_busy_in_range "$UDP_START" "$UDP_END" | tr '\n' ' ')"
  if [ -n "${BUSY_UDP// /}" ]; then
    die "UDP ports in $UDP_RANGE are already used (${BUSY_UDP% }). Pick a free range, for example --udp-range 40000-40100."
  fi
  TURN_PORT="$(pick_udp_port "$TURN_PORT" "TURN")"
  if [ "$TURN_PORT" -ge "$UDP_START" ] && [ "$TURN_PORT" -le "$UDP_END" ]; then die "The TURN port $TURN_PORT is inside the media range $UDP_RANGE; pick another --udp-range."; fi
fi

# ---- configuration --------------------------------------------------------------------------------------
mkdir -p "$DIR" "$CONFIG_DIR"
if [ ! -f "$ENV_FILE" ]; then
  info "Writing $ENV_FILE with new random secrets"
  cp "$REPO/Server/.env.example" "$ENV_FILE"
else
  info "Keeping the secrets in $ENV_FILE"
fi
chmod 600 "$ENV_FILE"
secret() {
  # Generated once; a value that is already set is never replaced.
  local current
  current="$(env_get "$ENV_FILE" "$1")"
  case "$current" in ""|CHANGE_ME*) env_set "$ENV_FILE" "$1" "$2" ;; esac
}
secret POSTGRES_PASSWORD "$(random_string 40)"
secret JWT_ACCESS_SECRET "$(random_string 64)"
secret LIVEKIT_API_KEY "API$(random_string 13)"
secret LIVEKIT_API_SECRET "$(random_string 48)"

env_set "$ENV_FILE" PUBLIC_BASE_URL "https://$DOMAIN"
case ",$(env_get "$ENV_FILE" CORS_ORIGINS)," in *",https://$DOMAIN,"*) ;; *) env_set "$ENV_FILE" CORS_ORIGINS "https://$DOMAIN" ;; esac
env_set "$ENV_FILE" LIVEKIT_URL "wss://rtc.$DOMAIN"
env_set "$ENV_FILE" LIVEKIT_TURN_DOMAIN "$DOMAIN"
env_set "$ENV_FILE" VOICE_NODE_DOMAIN "$DOMAIN"
env_set "$ENV_FILE" BACKEND_HOST_PORT "$BACKEND_PORT"
env_set "$ENV_FILE" LIVEKIT_HOST_PORT "$LIVEKIT_PORT"
env_set "$ENV_FILE" LIVEKIT_RTC_TCP_PORT "$RTC_TCP_PORT"
env_set "$ENV_FILE" LIVEKIT_RTC_PORT_START "$UDP_START"
env_set "$ENV_FILE" LIVEKIT_RTC_PORT_END "$UDP_END"
env_set "$ENV_FILE" TURN_UDP_HOST_PORT "$TURN_PORT"
if [ "$PROXY" = caddy ]; then
  env_set "$ENV_FILE" COMPOSE_FILE "docker-compose.yml:docker-compose.caddy.yml"
else
  env_set "$ENV_FILE" COMPOSE_FILE "docker-compose.yml"
fi
if [ "$VOICE" = yes ]; then env_set "$ENV_FILE" COMPOSE_PROFILES voice; else env_set "$ENV_FILE" COMPOSE_PROFILES ""; fi

if [ ! -f "$CONFIG_DIR/client-version.json" ]; then
  cp "$REPO/Server/config/client-version.example.json" "$CONFIG_DIR/client-version.json"
fi
if [ ! -s "$CONFIG_DIR/setup-code" ]; then
  random_string 24 >"$CONFIG_DIR/setup-code"
fi
chmod 600 "$CONFIG_DIR/setup-code"
# The backend runs as the "node" user (uid 1000) inside its container and reads the code from there.
[ "$DRY_RUN" = 1 ] || chown 1000:1000 "$CONFIG_DIR/setup-code"
SETUP_CODE="$(cat "$CONFIG_DIR/setup-code")"

render() {
  # render template output: fills in the names and ports; without voice the rtc.<domain> part is dropped.
  local drop='/^# voice-begin$/d;/^# voice-end$/d'
  [ "$VOICE" = yes ] || drop='/^# voice-begin$/,/^# voice-end$/d'
  sed -e "$drop" \
    -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__EMAIL__|$EMAIL|g" -e "s|__BACKEND_PORT__|$BACKEND_PORT|g" \
    -e "s|__LIVEKIT_PORT__|$LIVEKIT_PORT|g" -e "s|__WEB_DIR__|$WEB_DIR|g" "$REPO/deploy/templates/$1" >"$2"
}

NGINX_SITE=""
if [ "$PROXY" = caddy ]; then
  WEB_DIR="$DIR/web"
  render Caddyfile "$DIR/Caddyfile"
else
  rm -f "$DIR/Caddyfile"
  if [ "$DRY_RUN" = 1 ]; then
    WEB_DIR="$DIR/web"
    NGINX_SITE="$DIR/nginx-site.conf"
  else
    WEB_DIR="${S_WEB_DIR:-/var/www/aidis-$DOMAIN}"
    if [ -d /etc/nginx/sites-available ]; then NGINX_SITE="/etc/nginx/sites-available/aidis-$DOMAIN"; else NGINX_SITE="/etc/nginx/conf.d/aidis-$DOMAIN.conf"; fi
    for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
      [ -f "$f" ] || continue
      [ "$(readlink -f "$f")" = "$NGINX_SITE" ] && continue
      if grep -Eq "server_name[^;]*[[:space:]]$(echo "$DOMAIN" | sed 's/\./\\./g')[[:space:];]" "$f"; then
        die "nginx already has a site for $DOMAIN ($f). Remove it (or give AIDis another domain) and run this again."
      fi
    done
  fi
  # A file certbot already completed is not rewritten (that would drop its HTTPS part).
  if [ "$DRY_RUN" = 1 ] || [ ! -f "$NGINX_SITE" ] || ! grep -q "ssl_certificate" "$NGINX_SITE" || [ "$S_VOICE" != "$VOICE" ]; then
    render nginx-site.conf "$NGINX_SITE.new"
    mv "$NGINX_SITE.new" "$NGINX_SITE"
  fi
fi

cat >"$STATE" <<EOF
DOMAIN=$DOMAIN
EMAIL=$EMAIL
VOICE=$VOICE
PROXY=$PROXY
WEB_DIR=$WEB_DIR
NGINX_SITE=$NGINX_SITE
EOF

if [ "$DRY_RUN" = 1 ]; then
  info "Dry run: configuration written to $DIR, nothing started"
  print_summary "$SETUP_CODE"
  exit 0
fi

# ---- build and start --------------------------------------------------------------------------------------
build_web "$REPO" "$WEB_DIR"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  info "Opening ports in ufw"
  ufw allow 80/tcp
  ufw allow 443/tcp
  if [ "$VOICE" = yes ]; then
    ufw allow "$RTC_TCP_PORT/tcp"
    ufw allow "$UDP_START:$UDP_END/udp"
    ufw allow "$TURN_PORT/udp"
  fi
fi

info "Building and starting AIDis (the first build takes several minutes)"
cd "$DIR"
docker compose pull --ignore-buildable || note "could not pull every image now; docker compose up pulls what is missing"
docker compose build
docker compose up -d --remove-orphans

if [ "$PROXY" = nginx ]; then
  case "$NGINX_SITE" in
    /etc/nginx/sites-available/*) ln -sf "$NGINX_SITE" "/etc/nginx/sites-enabled/$(basename "$NGINX_SITE")" ;;
  esac
  if ! nginx -t; then
    rm -f "/etc/nginx/sites-enabled/$(basename "$NGINX_SITE")" "$NGINX_SITE"
    die "nginx rejected the AIDis site; it was removed again and nginx was not reloaded."
  fi
  systemctl reload nginx
  if ! grep -q "ssl_certificate" "$NGINX_SITE"; then
    if ! command -v certbot >/dev/null 2>&1; then
      info "Installing certbot"
      apt-get update -y
      apt-get install -y certbot python3-certbot-nginx
    fi
    info "Getting the certificate (certbot)"
    domains=(-d "$DOMAIN")
    [ "$VOICE" = no ] || domains+=(-d "rtc.$DOMAIN")
    certbot --nginx "${domains[@]}" --redirect --non-interactive --agree-tos -m "$EMAIL" || echo "WARNING: certbot failed - check the DNS records and that port 80 is open, then run this script again."
  fi
fi

info "Waiting for https://$DOMAIN (certificate and backend), up to 5 minutes"
if wait_healthy "$DOMAIN" 300; then
  info "AIDis answers on https://$DOMAIN"
else
  echo "WARNING: https://$DOMAIN does not answer yet. Check DNS and ports, then: cd $DIR && docker compose logs --tail 100"
fi

code=""
if setup_needed; then code="$SETUP_CODE"; else info "The first-run wizard is already finished; log in as the administrator."; fi
print_summary "$code"
