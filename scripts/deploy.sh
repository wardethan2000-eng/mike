#!/usr/bin/env bash
#
# Deploy Mike without cutting anybody off mid-answer.
#
# Restarting the backend kills the connection an answer is being written down,
# so the answer stops mid-sentence. The backend now saves what it has when it
# is stopped, but half an answer is still a lost answer — so this waits for the
# app to be idle first.
#
#   scripts/deploy.sh                 # backend and frontend, waiting for idle
#   scripts/deploy.sh backend         # one service
#   scripts/deploy.sh --now           # do not wait (someone may lose an answer)
#   scripts/deploy.sh --wait 1800     # wait longer than the default 15 minutes
#
set -euo pipefail
cd "$(dirname "$0")/.."

HEALTH_URL="${MIKE_HEALTH_URL:-http://localhost:3001/health}"
WAIT_SECONDS=900
NOW=0
SERVICES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --now|--force) NOW=1 ;;
    --wait) shift; WAIT_SECONDS="$1" ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) SERVICES+=("$1") ;;
  esac
  shift
done
[ ${#SERVICES[@]} -eq 0 ] && SERVICES=(backend frontend)

active_answers() {
  # A backend that cannot be reached is a backend nobody is mid-answer on.
  curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null \
    | sed -n 's/.*"active_answers":[[:space:]]*\([0-9]*\).*/\1/p' \
    | head -1
}

if [ "$NOW" = "0" ]; then
  deadline=$(( $(date +%s) + WAIT_SECONDS ))
  while :; do
    count="$(active_answers)"
    count="${count:-0}"
    [ "$count" = "0" ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "Still $count answer(s) being written after ${WAIT_SECONDS}s." >&2
      echo "Deploy anyway with: scripts/deploy.sh --now ${SERVICES[*]}" >&2
      exit 1
    fi
    echo "Waiting: $count answer(s) being written. Checking again in 10s."
    sleep 10
  done
fi

echo "Building ${SERVICES[*]}..."
docker compose build "${SERVICES[@]}"

# Check once more: a build takes minutes, and somebody may have started asking
# something in the meantime.
if [ "$NOW" = "0" ]; then
  count="$(active_answers)"
  count="${count:-0}"
  while [ "$count" != "0" ]; do
    echo "Built. Waiting for $count answer(s) to finish before restarting."
    sleep 10
    count="$(active_answers)"
    count="${count:-0}"
  done
fi

echo "Restarting ${SERVICES[*]}..."
docker compose up -d --no-deps "${SERVICES[@]}"
docker compose ps --format "{{.Service}} {{.Status}}" | grep -E "$(IFS='|'; echo "${SERVICES[*]}")" || true
