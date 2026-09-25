#!/usr/bin/env bash
# Local (or server) Perk stack: indexer + read API, the web app, and the testnet demo driver.
#
#   scripts/stack.sh up [api|web|driver ...]     start everything, or only the named services
#   scripts/stack.sh down [api|web|driver ...]   stop them
#   scripts/stack.sh status                      what is running, and how far the indexer has got
#   scripts/stack.sh logs <service>              tail a log
#
# Configuration comes from .env.dev (see .env.example). The paid RPC key is read here and handed to the server-side
# processes only; the browser never receives it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.run"
LOGS="$ROOT/.run/logs"
mkdir -p "$RUN" "$LOGS"

for f in "$ROOT/.env.dev" "$ROOT/.env"; do
  if [ -f "$f" ]; then set -a; . "$f"; set +a; break; fi
done

CHAIN_ID="${CHAIN_ID:-1952}"
: "${ALCHEMY_API_KEY:?ALCHEMY_API_KEY is not set (see .env.example)}"
if [ -z "${RPC_URL:-}" ]; then
  if [ "$CHAIN_ID" = "196" ]; then
    RPC_URL="https://xlayer-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}"
  else
    RPC_URL="https://xlayer-testnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}"
  fi
fi
export RPC_URL CHAIN_ID
export DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/perk_dev}"
export PORT="${PORT:-8787}"
export PUBLIC_API_URL="${PUBLIC_API_URL:-http://localhost:${PORT}}"
export MEDIA_DRIVER="${MEDIA_DRIVER:-local}"
export MEDIA_DIR="${MEDIA_DIR:-$ROOT/backend/data/media}"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000}"

SERVICES=(api web driver)

pidfile() { echo "$RUN/$1.pid"; }
logfile() { echo "$LOGS/$1.log"; }

running() {
  local pf; pf="$(pidfile "$1")"
  [ -f "$pf" ] || return 1
  local pid; pid="$(cat "$pf")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_one() {
  local svc="$1"
  if running "$svc"; then echo "[$svc] already running (pid $(cat "$(pidfile "$svc")"))"; return; fi
  case "$svc" in
    api)    ( cd "$ROOT/backend"  && exec bun run src/main.ts ) >>"$(logfile api)" 2>&1 & ;;
    # next dev reads PORT too, so give the web app its own and point it at the API
    web)    ( cd "$ROOT/frontend" && PORT="${WEB_PORT:-3000}" NEXT_PUBLIC_API_URL="$PUBLIC_API_URL" exec bun run dev ) >>"$(logfile web)" 2>&1 & ;;
    driver) ( cd "$ROOT/mock" && exec bun run src/main.ts ) >>"$(logfile driver)" 2>&1 & ;;
    *) echo "unknown service: $svc" >&2; return 1 ;;
  esac
  echo $! > "$(pidfile "$svc")"
  echo "[$svc] started (pid $!) -> $(logfile "$svc")"
}

stop_one() {
  local svc="$1" pf pid
  pf="$(pidfile "$svc")"
  if ! running "$svc"; then echo "[$svc] not running"; rm -f "$pf"; return; fi
  pid="$(cat "$pf")"
  # the service is the process group leader of whatever it spawned (next dev forks a child)
  kill "$pid" 2>/dev/null || true
  pkill -P "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pf"
  echo "[$svc] stopped"
}

cmd="${1:-status}"; shift || true
targets=("$@"); [ ${#targets[@]} -eq 0 ] && targets=("${SERVICES[@]}")

case "$cmd" in
  up)   for s in "${targets[@]}"; do start_one "$s"; done ;;
  down) for s in "${targets[@]}"; do stop_one "$s"; done ;;
  logs) tail -f "$(logfile "${targets[0]}")" ;;
  status)
    for s in "${SERVICES[@]}"; do
      if running "$s"; then echo "$s: up (pid $(cat "$(pidfile "$s")"))"; else echo "$s: down"; fi
    done
    echo "--- web ---"
    curl -s -o /dev/null -w "http://localhost:${WEB_PORT:-3000} -> %{http_code}\n" "http://localhost:${WEB_PORT:-3000}/trade" || true
    echo "--- api health ---"
    curl -s "http://localhost:${PORT}/health" || echo "(no response)"
    echo
    ;;
  *) echo "usage: $0 {up|down|status|logs} [service ...]" >&2; exit 2 ;;
esac
