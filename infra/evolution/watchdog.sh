#!/usr/bin/env bash
# Evolution API zombie-session watchdog.
#
# Runs every minute from cron on the Oracle VM. Detects the failure mode where
# the Baileys WebSocket to WhatsApp is dead while the instance still reports
# connectionState "open" (every send fails with Boom 428 "Connection Closed",
# no inbound webhooks arrive). The backend's gatewayHealthMonitor performs an
# API-level instance restart first; this watchdog is the escalation path that
# restarts the Docker container when the API-level heal is not enough (node
# process wedged, Prisma/Postgres connectivity broken, API hung).
#
# Install:
#   crontab: * * * * * /home/ubuntu/evolution-api/watchdog.sh >/dev/null 2>&1
#
# State/logs live in /home/ubuntu/evolution-api/.watchdog/

set -u

BASE_DIR="/home/ubuntu/evolution-api"
STATE_DIR="$BASE_DIR/.watchdog"
LOG_FILE="$STATE_DIR/watchdog.log"
LOCK_FILE="$STATE_DIR/lock"
API_URL="http://127.0.0.1:8080"
CONTAINER="evolution_api"

INSTANCE="${WATCHDOG_INSTANCE:-rozare-seller}"
# Number used for the socket-liveness probe (the linked bot number always exists).
PROBE_NUMBER="${WATCHDOG_PROBE_NUMBER:-923201166402}"
# Consecutive failed probes before restarting the container (minutes).
ZOMBIE_THRESHOLD=3
API_DOWN_THRESHOLD=3
# Minimum seconds between container restarts.
RESTART_COOLDOWN=900

mkdir -p "$STATE_DIR"

# Read the API key from the compose .env (AUTHENTICATION_API_KEY=...).
APIKEY="$(grep -E '^AUTHENTICATION_API_KEY=' "$BASE_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "$APIKEY" ]; then
  echo "$(date -u '+%F %T') ERROR cannot read AUTHENTICATION_API_KEY from $BASE_DIR/.env" >> "$LOG_FILE"
  exit 1
fi

log() { echo "$(date -u '+%F %T') $*" >> "$LOG_FILE"; }

get_count() { cat "$STATE_DIR/$1" 2>/dev/null || echo 0; }
set_count() { echo "$2" > "$STATE_DIR/$1"; }

rotate_log() {
  local size
  size=$(stat -c '%s' "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$size" -gt 1048576 ]; then
    tail -c 262144 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

restart_container() {
  local reason="$1"
  local now last
  now=$(date +%s)
  last=$(get_count last_restart)
  if [ $((now - last)) -lt "$RESTART_COOLDOWN" ]; then
    log "WARN restart wanted ($reason) but on cooldown ($((now - last))s since last)"
    return
  fi
  set_count last_restart "$now"
  set_count zombie_fails 0
  set_count api_fails 0
  log "ACTION restarting $CONTAINER: $reason"
  docker restart "$CONTAINER" >> "$LOG_FILE" 2>&1
}

# Serialize runs (a stuck docker restart can outlive one cron interval).
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

rotate_log

# ── 1. Is the API itself responding? ─────────────────────────────────────────
if ! curl -sf -m 10 "$API_URL/" >/dev/null 2>&1; then
  fails=$(( $(get_count api_fails) + 1 ))
  set_count api_fails "$fails"
  log "WARN API not responding (consecutive: $fails)"
  if [ "$fails" -ge "$API_DOWN_THRESHOLD" ]; then
    restart_container "API unresponsive for $fails checks"
  fi
  exit 0
fi
set_count api_fails 0

# ── 2. Connection state ──────────────────────────────────────────────────────
STATE_JSON="$(curl -sf -m 10 -H "apikey: $APIKEY" "$API_URL/instance/connectionState/$INSTANCE" 2>/dev/null || echo '')"
STATE="$(echo "$STATE_JSON" | grep -o '"state":"[^"]*"' | head -1 | cut -d'"' -f4)"

if [ "$STATE" != "open" ]; then
  # Not open: could be reconnecting or genuinely logged out (needs QR scan).
  # A container restart cannot fix a logged-out session, so never restart here —
  # just log. Evolution and the backend monitor handle reconnection nudges.
  set_count zombie_fails 0
  log "INFO state=$STATE (not open) — no action"
  exit 0
fi

# ── 3. State is open — verify the socket is actually alive ───────────────────
PROBE="$(curl -s -m 20 -X POST -H "apikey: $APIKEY" -H 'Content-Type: application/json' \
  -d "{\"numbers\":[\"$PROBE_NUMBER\"]}" \
  "$API_URL/chat/whatsappNumbers/$INSTANCE" 2>/dev/null || echo '')"

if echo "$PROBE" | grep -q '"exists"'; then
  # Socket is alive.
  prev=$(get_count zombie_fails)
  [ "$prev" -gt 0 ] && log "INFO socket recovered after $prev failed probes"
  set_count zombie_fails 0
  exit 0
fi

if echo "$PROBE" | grep -qi 'Connection Closed'; then
  fails=$(( $(get_count zombie_fails) + 1 ))
  set_count zombie_fails "$fails"
  log "WARN ZOMBIE: state=open but socket probe says Connection Closed (consecutive: $fails)"
  if [ "$fails" -ge "$ZOMBIE_THRESHOLD" ]; then
    restart_container "zombie session: state=open, socket dead for $fails checks"
  fi
  exit 0
fi

# Indeterminate probe result (timeout / unexpected body) — log, don't count.
log "INFO probe indeterminate: $(echo "$PROBE" | head -c 160)"
exit 0
