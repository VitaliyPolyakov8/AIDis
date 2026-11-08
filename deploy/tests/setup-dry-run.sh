#!/usr/bin/env bash
# Dry-run scenarios for deploy/setup.sh. Nothing is installed or started: --dry-run only writes the
# files into a temporary folder. Busy ports are faked through AIDIS_FAKE_TCP / AIDIS_FAKE_UDP.
#
#   bash deploy/tests/setup-dry-run.sh
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
S="$HERE/setup.sh"
T="$(mktemp -d)"
pass=0
fail=0
check() {
  if eval "$2"; then
    echo "PASS $1"
    pass=$((pass + 1))
  else
    echo "FAIL $1"
    fail=$((fail + 1))
    echo "---- output:"
    cat "$T/out"
  fi
}
run() {
  shift
  ("$@") >"$T/out" 2>&1
  echo $? >"$T/code"
}
code() { cat "$T/code"; }
D="--domain chat.example.com --email admin@example.com --dry-run"
envv() { grep "^$2=" "$T/$1/.env" | tail -n1 | cut -d= -f2-; }
state() { grep "^$2=" "$T/$1/install.env" | cut -d= -f2-; }

for f in setup.sh update.sh lib/common.sh tests/setup-dry-run.sh; do
  check "syntax $f" "bash -n '$HERE/$f'"
  check "LF line endings $f" "! grep -q \$'\\r' '$HERE/$f'"
done

# 1. clean VPS -> Caddy, voice on, everything generated
run a env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="" bash "$S" $D --voice yes --dir "$T/a"
check "clean: ok, caddy" '[ "$(code)" = 0 ] && [ "$(state a PROXY)" = caddy ] && [ -f $T/a/Caddyfile ] && [ ! -f $T/a/nginx-site.conf ]'
check "clean: caddy serves site and rtc" 'grep -q "^chat.example.com {" $T/a/Caddyfile && grep -q "^rtc.chat.example.com {" $T/a/Caddyfile && grep -q "reverse_proxy 127.0.0.1:18080" $T/a/Caddyfile && grep -q "reverse_proxy 127.0.0.1:17880" $T/a/Caddyfile && grep -q "email admin@example.com" $T/a/Caddyfile'
check "clean: .env addresses" '[ "$(envv a PUBLIC_BASE_URL)" = https://chat.example.com ] && [ "$(envv a CORS_ORIGINS)" = https://chat.example.com ] && [ "$(envv a LIVEKIT_URL)" = wss://rtc.chat.example.com ] && [ "$(envv a VOICE_NODE_DOMAIN)" = chat.example.com ] && [ "$(envv a LIVEKIT_TURN_DOMAIN)" = chat.example.com ]'
check "clean: compose files and voice profile" '[ "$(envv a COMPOSE_FILE)" = docker-compose.yml:docker-compose.caddy.yml ] && [ "$(envv a COMPOSE_PROFILES)" = voice ]'
check "clean: real secrets" 's=$(envv a JWT_ACCESS_SECRET); p=$(envv a POSTGRES_PASSWORD); k=$(envv a LIVEKIT_API_KEY); x=$(envv a LIVEKIT_API_SECRET); [ ${#s} -ge 48 ] && [ ${#p} -ge 32 ] && [ ${#x} -ge 48 ] && [ -n "$k" ] && ! grep -q "=CHANGE_ME" $T/a/.env'
check "clean: .env is private" '[ "$(stat -c %a $T/a/.env 2>/dev/null || echo 600)" = 600 ] || [ "$(uname -o 2>/dev/null)" = Msys ]'
check "clean: setup code + link" 'c=$(cat $T/a/config/setup-code); [ ${#c} = 24 ] && grep -q "https://chat.example.com/setup?code=$c" $T/out'
check "clean: client-version.json" 'grep -q "\"latestVersion\"" $T/a/config/client-version.json'
check "clean: firewall list" 'grep -q "80/tcp, 443/tcp" $T/out && grep -q "17881/tcp" $T/out && grep -q "50000-50100/udp" $T/out && grep -q "13478/udp" $T/out'
check "clean: DNS records listed" 'grep -q "chat.example.com" $T/out && grep -q "rtc.chat.example.com" $T/out'

# 2. Review Focus 5: running it again keeps every secret, the setup code and the owner's own edits
s1=$(envv a JWT_ACCESS_SECRET); p1=$(envv a POSTGRES_PASSWORD); k1=$(envv a LIVEKIT_API_KEY); x1=$(envv a LIVEKIT_API_SECRET); c1=$(cat "$T/a/config/setup-code")
printf 'GIF_PROVIDER=tenor\nMY_NOTE=kept\n' >>"$T/a/.env"
run a2 env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="" bash "$S" --dry-run --dir "$T/a"
check "rerun: no questions, ok" '[ "$(code)" = 0 ] && [ "$(state a DOMAIN)" = chat.example.com ]'
check "rerun: same secrets" '[ "$(envv a JWT_ACCESS_SECRET)" = "$s1" ] && [ "$(envv a POSTGRES_PASSWORD)" = "$p1" ] && [ "$(envv a LIVEKIT_API_KEY)" = "$k1" ] && [ "$(envv a LIVEKIT_API_SECRET)" = "$x1" ]'
check "rerun: same setup code" '[ "$(cat $T/a/config/setup-code)" = "$c1" ]'
check "rerun: owner edits kept" '[ "$(envv a GIF_PROVIDER)" = tenor ] && [ "$(envv a MY_NOTE)" = kept ] && [ $(grep -c "^PUBLIC_BASE_URL=" $T/a/.env) = 1 ]'

# 3. --voice no: LiveKit is not started, its secrets stay for later
run a3 env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="" bash "$S" --dry-run --voice no --dir "$T/a"
check "voice off: no profile, no rtc site" '[ "$(code)" = 0 ] && [ -z "$(envv a COMPOSE_PROFILES)" ] && ! grep -q "^rtc.chat.example.com" $T/a/Caddyfile && [ "$(state a VOICE)" = no ]'
check "voice off: livekit secrets untouched" '[ "$(envv a LIVEKIT_API_KEY)" = "$k1" ] && [ "$(envv a LIVEKIT_API_SECRET)" = "$x1" ]'
check "voice off: no voice ports in firewall list" '! grep -q "17881/tcp" $T/out && grep -q "80/tcp, 443/tcp" $T/out'

# 4. VPS with nginx on 80/443 and other services on our default ports
run b env AIDIS_FAKE_TCP="80:nginx 443:nginx 18080:node 17881:docker-proxy" AIDIS_FAKE_UDP="13478 7882" bash "$S" $D --voice yes --dir "$T/b"
check "nginx vps: nginx mode" '[ "$(code)" = 0 ] && [ "$(state b PROXY)" = nginx ] && [ ! -f $T/b/Caddyfile ] && [ "$(envv b COMPOSE_FILE)" = docker-compose.yml ]'
check "nginx vps: ports moved" '[ "$(envv b BACKEND_HOST_PORT)" = 18090 ] && [ "$(envv b LIVEKIT_RTC_TCP_PORT)" = 17891 ] && [ "$(envv b TURN_UDP_HOST_PORT)" = 13479 ] && grep -q "using 17891 instead" $T/out'
check "nginx vps: site for both names" 'grep -q "server_name chat.example.com;" $T/b/nginx-site.conf && grep -q "server_name rtc.chat.example.com;" $T/b/nginx-site.conf && grep -q "proxy_pass http://127.0.0.1:18090;" $T/b/nginx-site.conf && grep -q "proxy_pass http://127.0.0.1:17880;" $T/b/nginx-site.conf && grep -q "try_files \$uri \$uri/ /index.html;" $T/b/nginx-site.conf'
check "nginx vps: websocket upgrade" 'grep -q "proxy_set_header Upgrade \$http_upgrade;" $T/b/nginx-site.conf'

# 5. 80/443 taken by something that is not nginx -> stop before writing anything
run c env AIDIS_FAKE_TCP="80:apache2 443:apache2" AIDIS_FAKE_UDP="" bash "$S" $D --dir "$T/c"
check "apache: refuses, nothing written" '[ "$(code)" != 0 ] && grep -q "not by nginx" $T/out && [ ! -f $T/c/.env ]'

# 6. --proxy caddy while nginx holds 443
run d env AIDIS_FAKE_TCP="80:nginx 443:nginx" AIDIS_FAKE_UDP="" bash "$S" $D --proxy caddy --dir "$T/d"
check "forced caddy on busy 443: refuses" '[ "$(code)" != 0 ] && grep -q "use --proxy nginx" $T/out'

# 7. busy UDP inside the media range
run e env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="50050" bash "$S" $D --dir "$T/e"
check "udp clash: refuses with advice" '[ "$(code)" != 0 ] && grep -q "50000-50100 are already used (50050)" $T/out && grep -q -- "--udp-range" $T/out'
run e2 env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="50050" bash "$S" $D --udp-range 40000-40100 --dir "$T/e2"
check "udp other range: ok" '[ "$(code)" = 0 ] && [ "$(envv e2 LIVEKIT_RTC_PORT_START)" = 40000 ] && [ "$(envv e2 LIVEKIT_RTC_PORT_END)" = 40100 ]'

# 8. bad input
run f env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="" bash "$S" --domain "https://chat.example.com/" --email admin@example.com --dry-run --dir "$T/f"
check "bad domain: refuses" '[ "$(code)" != 0 ] && grep -q "Not a valid domain" $T/out'
run g env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="" bash "$S" --domain chat.example.com --email nope --dry-run --dir "$T/g"
check "bad email: refuses" '[ "$(code)" != 0 ] && grep -q "Not a valid e-mail" $T/out'
run h env AIDIS_FAKE_TCP="" AIDIS_FAKE_UDP="" bash "$S" --dry-run --dir "$T/h" </dev/null
check "dry run without domain: refuses" '[ "$(code)" != 0 ] && grep -q -- "--domain is required" $T/out'

# 9. the port checks are the same code as in voice-node/install.sh
fn() { awk -v n="$1" '$0 ~ "^"n"\\(\\) \\{" {p=1} p {print} p && /^}/ {exit}' "$2"; }
for name in tcp_owner udp_busy_in_range; do
  check "same $name as voice-node" '[ -n "$(fn $name $HERE/lib/common.sh)" ] && [ "$(fn $name $HERE/lib/common.sh)" = "$(fn $name $HERE/../voice-node/install.sh)" ]'
done

rm -rf "$T"
echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
