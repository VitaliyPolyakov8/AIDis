#!/usr/bin/env bash
# RUN ON THE SERVER, from the AIDis Server directory, BEFORE the first start:
#   ./scripts/check-ports.sh
#
# Read-only: reads the port numbers chosen in .env and reports whether something on
# this host already listens on them. It never stops, kills or changes anything.
# If a port is busy: pick another number in .env. Do not stop the other service.
#
# Note: once AIDis itself is running, its own ports will of course show as "IN USE".
set -euo pipefail

cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo "No .env found. Run: cp .env.example .env  and edit it first." >&2
  exit 1
fi

get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" ; }

listening="$(sudo ss -H -tuln)"
problems=0

check() { # proto port label
  local proto="$1" port="$2" label="$3"
  if [ -z "$port" ] || [ "$port" = "0" ]; then
    printf '  %-28s %-5s %-12s %s\n' "$label" "$proto" "-" "disabled"
    return
  fi
  if echo "$listening" | awk -v p="$proto" '$1==p {print $5}' | grep -Eq "[:.]$port\$"; then
    printf '  %-28s %-5s %-12s %s\n' "$label" "$proto" "$port" "IN USE  <-- choose another port"
    problems=1
  else
    printf '  %-28s %-5s %-12s %s\n' "$label" "$proto" "$port" "free"
  fi
}

echo "AIDis port check (from .env):"
check tcp "$(get BACKEND_HOST_PORT)" "Backend (localhost)"
check tcp "$(get LIVEKIT_HOST_PORT)" "LiveKit signaling (localhost)"
check tcp "$(get LIVEKIT_RTC_TCP_PORT)" "LiveKit RTC TCP (public)"
check udp "$(get TURN_UDP_HOST_PORT)" "TURN UDP (public)"
check tcp "$(get TURN_TLS_HOST_PORT)" "TURN TLS (public, optional)"

start="$(get LIVEKIT_RTC_PORT_START)"
end="$(get LIVEKIT_RTC_PORT_END)"
busy_in_range=""
if [ -n "$start" ] && [ -n "$end" ]; then
  for port in $(echo "$listening" | awk '$1=="udp" {print $5}' | sed -E 's/.*[:.]([0-9]+)$/\1/' | sort -un); do
    if [ "$port" -ge "$start" ] && [ "$port" -le "$end" ]; then busy_in_range="$busy_in_range $port"; fi
  done
fi
if [ -n "$busy_in_range" ]; then
  printf '  %-28s %-5s %-12s %s\n' "LiveKit RTC UDP range" "udp" "$start-$end" "IN USE:$busy_in_range  <-- choose another range"
  problems=1
else
  printf '  %-28s %-5s %-12s %s\n' "LiveKit RTC UDP range" "udp" "$start-$end" "free"
fi

echo
echo "Docker containers already publishing ports:"
docker ps --format '  {{.Names}}\t{{.Ports}}' || true

if [ "$problems" -ne 0 ]; then
  echo
  echo "Some ports are taken. Find the owner with:  sudo ss -tulpn | grep ':<port>'"
  echo "Then change the AIDis port in .env and run this script again."
  exit 1
fi
echo
echo "All selected AIDis ports are free."
