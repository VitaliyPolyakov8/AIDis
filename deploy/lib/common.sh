# Shared by deploy/setup.sh and deploy/update.sh (sourced, never run on its own).
# The port checks are the same code as voice-node/install.sh (deploy/tests/setup-dry-run.sh compares them).

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
note() { echo "NOTE: $*"; }

random_string() {
  # Letters and digits only (safe in .env, YAML and when pasted).
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true
}

# ---- ports ------------------------------------------------------------------------------------------
# Tests can describe busy ports instead of asking ss: AIDIS_FAKE_TCP="80:nginx 443:nginx 17881:docker-proxy",
# AIDIS_FAKE_UDP="13478 50005".
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

# A free TCP port: the wanted one, or (when it was not set by hand) the next free of wanted+10, +20, ...
# Ports listed in $4 (space separated) count as taken (chosen earlier in this run).
pick_tcp_port() {
  local wanted="$1" explicit="$2" what="$3" taken=" ${4:-} " owner candidate i
  owner="$(tcp_owner "$wanted")"
  if [ -z "$owner" ] && [ "${taken#* "$wanted" }" = "$taken" ]; then echo "$wanted"; return 0; fi
  if [ "$explicit" = 1 ]; then
    die "$what port $wanted is already used by '${owner:-this installation}'. Pick another one."
  fi
  for i in 1 2 3 4 5 6 7 8 9 10 11; do
    candidate=$((wanted + i * 10))
    if [ "${taken#* "$candidate" }" = "$taken" ] && [ -z "$(tcp_owner "$candidate")" ]; then
      echo "NOTE: $what port $wanted is used by '${owner:-this installation}', using $candidate instead." >&2
      echo "$candidate"
      return 0
    fi
  done
  die "$what port $wanted is busy and no free port was found among $((wanted + 10))-$((wanted + 110)); set one in the .env file."
}

# A free single UDP port: the wanted one or the next free of wanted+1 .. +20.
pick_udp_port() {
  local wanted="$1" what="$2" candidate i
  if [ -z "$(udp_busy_in_range "$wanted" "$wanted")" ]; then echo "$wanted"; return 0; fi
  for i in $(seq 1 20); do
    candidate=$((wanted + i))
    if [ -z "$(udp_busy_in_range "$candidate" "$candidate")" ]; then
      echo "NOTE: $what UDP port $wanted is already used, using $candidate instead." >&2
      echo "$candidate"
      return 0
    fi
  done
  die "$what UDP port $wanted is busy and no free port was found among $((wanted + 1))-$((wanted + 20))."
}

# ---- .env ---------------------------------------------------------------------------------------------
env_get() {
  # The value of KEY in an env file (the last line wins, like docker compose).
  [ -f "$1" ] || return 0
  awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { if (v != "") print v }' "$1"
}

env_set() {
  # Replaces KEY=... in place (the first line; later duplicates are dropped) or appends it.
  local file="$1" tmp
  tmp="$(mktemp)"
  awk -v k="$2" -v v="$3" '
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# ---- web client ----------------------------------------------------------------------------------------
# Builds Client/ in a throwaway Node container (nothing is installed on the VPS) into the folder $2.
build_web() {
  local repo="$1" out="$2"
  info "Building the web client (Node in Docker; a few minutes on a small VPS)"
  docker run --rm -v "$repo/Client:/src" -w /src -e VITE_API_URL= node:24-bookworm-slim \
    sh -c 'npm ci --no-audit --no-fund --loglevel=error && npm run build' || die "The web client did not build (see the output above)."
  rm -rf "$out"
  mkdir -p "$out"
  cp -a "$repo/Client/dist/." "$out/"
  chmod -R a+rX "$out"
}

# Waits until https://DOMAIN/health answers 200 (up to $2 seconds).
wait_healthy() {
  local url="https://$1/health" left="${2:-180}"
  while [ "$left" -gt 0 ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")" = "200" ]; then return 0; fi
    sleep 5
    left=$((left - 5))
  done
  return 1
}
