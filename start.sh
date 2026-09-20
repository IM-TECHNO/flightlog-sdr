#!/usr/bin/env bash
# Start flightlog-sdr (API + web app) on Linux or macOS. Ctrl+C stops both.
#   ./start.sh                 default ports 8000 (API) and 3000 (web)
#   ./start.sh --lan           reachable from other devices on your network
#   ./start.sh --dev           Next.js dev server instead of build + start
#   API_PORT=8010 WEB_PORT=3010 ./start.sh --rebuild
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_port="${API_PORT:-8000}"; web_port="${WEB_PORT:-3000}"
bind=127.0.0.1; dev=0; rebuild=0
for a in "$@"; do
  case "$a" in
    --lan) bind=0.0.0.0 ;;
    --dev) dev=1 ;;
    --rebuild) rebuild=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "node not found: install Node 20+" >&2; exit 1; }
command -v npm  >/dev/null || { echo "npm not found: install Node 20+" >&2; exit 1; }
py="$(command -v python3 || command -v python || true)"
[ -n "$py" ] || { echo "python not found: install Python 3.11+" >&2; exit 1; }

cd "$root/backend"
if [ ! -x .venv/bin/python ]; then echo "> creating Python environment (first run)"; "$py" -m venv .venv; fi
echo "> checking Python packages"
.venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
if [ ! -f .env ]; then
  cp .env.example .env
  echo "> created backend/.env: set RECEIVER_LAT / RECEIVER_LON in it, then restart"
fi

cd "$root/frontend"
if [ ! -d node_modules ]; then echo "> installing web app packages (first run)"; npm install; fi
[ "$api_port" = 8000 ] || export NEXT_PUBLIC_API_URL="http://localhost:$api_port"
if [ "$dev" = 0 ] && { [ "$rebuild" = 1 ] || [ ! -f .next/BUILD_ID ]; }; then
  echo "> building the web app (first run takes a minute or two)"; npm run build
fi

pids=()
cleanup() { trap - INT TERM EXIT; kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup INT TERM EXIT

( cd "$root/backend" && exec .venv/bin/python -m uvicorn app.main:app --host "$bind" --port "$api_port" ) & pids+=($!)
if [ "$dev" = 1 ]; then web=(npm run dev -- -H "$bind" -p "$web_port"); else web=(npm start -- -H "$bind" -p "$web_port"); fi
( cd "$root/frontend" && exec "${web[@]}" ) & pids+=($!)

echo; echo "flightlog-sdr is starting:  http://localhost:$web_port   (API on port $api_port). Ctrl+C to stop."
wait -n
echo "one of the processes stopped; shutting down."
