#!/usr/bin/env bash
# Evolution API v2.3.7 — one-shot deployment on Oracle Cloud Ubuntu VM.
#
# Usage (from your Mac, NOT from the server):
#   ./infra/evolution/deploy.sh
#
# This script:
#   1. Checks SSH connectivity to the Oracle VM
#   2. Uploads docker-compose.yml + .env to ~/evolution-api/
#   3. Stops any old containers, pulls new images, starts the stack
#   4. Waits for health checks
#   5. Prints Evolution API status and next steps
#
# Idempotent — safe to re-run.

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
: "${SSH_KEY:=$HOME/Downloads/ssh-key-2026-04-28.key}"
: "${SSH_USER:=ubuntu}"
: "${SSH_HOST:=80.225.254.66}"
: "${REMOTE_DIR:=/home/ubuntu/evolution-api}"
: "${API_KEY:=rozareplatform}"
: "${INSTANCE_NAME:=rozare-seller}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_SRC="${SCRIPT_DIR}/docker-compose.yml"
ENV_SRC="${SCRIPT_DIR}/.env"
DOCKERFILE_SRC="${SCRIPT_DIR}/Dockerfile"
PATCHES_SRC="${SCRIPT_DIR}/patches"

# ── Helpers ──────────────────────────────────────────────────────────────────
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
step()    { c_blue "▶ $*"; }

SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 ${SSH_USER}@${SSH_HOST}"
SCP="scp -i ${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30"

# ── Pre-flight ───────────────────────────────────────────────────────────────
step "Verifying local files…"
[ -f "$COMPOSE_SRC" ] || { c_red "Missing $COMPOSE_SRC"; exit 1; }
[ -f "$ENV_SRC" ]     || { c_red "Missing $ENV_SRC";     exit 1; }
[ -f "$DOCKERFILE_SRC" ] || { c_red "Missing $DOCKERFILE_SRC"; exit 1; }
[ -d "$PATCHES_SRC" ] || { c_red "Missing $PATCHES_SRC"; exit 1; }
[ -f "$SSH_KEY" ]     || { c_red "SSH key not found at $SSH_KEY"; exit 1; }
chmod 600 "$SSH_KEY" || true

step "Checking SSH connectivity to ${SSH_HOST}…"
if ! $SSH "echo ok" >/dev/null 2>&1; then
    c_red "Cannot SSH to ${SSH_HOST}."
    c_yellow "The Oracle Cloud VM is unreachable. Fix it via the Oracle Cloud Console:"
    cat <<'HELP'

  1. https://cloud.oracle.com/  →  Compute  →  Instances
  2. Open the instance that hosts Evolution API (public IP 80.225.254.66).
  3. If state is "Stopped" → click "Start".
     If state is "Running" but frozen → click the three-dot menu → "Reboot"
       (pick "Reboot" first; only use "Force Reboot" if a normal reboot fails).
  4. Wait 2–3 minutes, then re-run this script.
  5. If the public IP changed, update both:
        - Backend/.env           EVOLUTION_API_URL
        - infra/evolution/.env   SERVER_URL
     and Heroku: `heroku config:set EVOLUTION_API_URL=... --app tortrose-backend`.
  6. Verify the Oracle VCN Security List has an ingress rule allowing TCP 8080
     from 0.0.0.0/0 (or at least from Heroku's outbound range / your admin IP).

HELP
    exit 1
fi
c_green "✓ SSH reachable"

# ── Upload ───────────────────────────────────────────────────────────────────
step "Ensuring remote directory ${REMOTE_DIR}…"
$SSH "mkdir -p ${REMOTE_DIR}"

step "Uploading docker-compose.yml, Dockerfile, patches, and .env…"
$SCP "$COMPOSE_SRC" "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/docker-compose.yml"
$SCP "$DOCKERFILE_SRC" "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/Dockerfile"
$SSH "mkdir -p ${REMOTE_DIR}/patches"
$SCP "$PATCHES_SRC"/* "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/patches/"
$SCP "$ENV_SRC"     "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/.env"
c_green "✓ Files uploaded"

# ── Verify Docker on the host ────────────────────────────────────────────────
step "Checking Docker…"
if ! $SSH "docker --version && docker compose version" >/dev/null 2>&1; then
    c_red "Docker or Docker Compose v2 is not installed on the server."
    c_yellow "Install with:"
    cat <<'INSTALL'
  ssh ubuntu@<host>
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker ubuntu
  sudo systemctl enable --now docker
  # Log out and back in, then re-run this script.
INSTALL
    exit 1
fi
c_green "✓ Docker OK"

# ── Stop old containers (safe — ignore errors if they don't exist) ───────────
step "Stopping any previous Evolution containers…"
$SSH "cd ${REMOTE_DIR} && docker compose down --remove-orphans 2>/dev/null || true"
$SSH "docker rm -f evolution_api evolution_mongo evolution_postgres evolution_redis 2>/dev/null || true"

# ── Pull + start ─────────────────────────────────────────────────────────────
step "Pulling base images and building patched Evolution API image…"
$SSH "cd ${REMOTE_DIR} && docker compose pull postgres redis"
$SSH "cd ${REMOTE_DIR} && docker compose build evolution-api"

step "Starting stack…"
$SSH "cd ${REMOTE_DIR} && docker compose up -d"

# ── Wait for health ──────────────────────────────────────────────────────────
step "Waiting for containers to become healthy (up to 120s)…"
for i in $(seq 1 24); do
    sleep 5
    STATE=$($SSH "docker inspect -f '{{.State.Health.Status}}' evolution_api 2>/dev/null || echo unknown")
    if [ "$STATE" = "healthy" ]; then
        c_green "✓ evolution_api is healthy (after $((i*5))s)"
        break
    fi
    if [ "$STATE" = "unhealthy" ]; then
        c_red "✗ evolution_api is unhealthy. Dumping logs:"
        $SSH "docker logs evolution_api --tail 80"
        exit 1
    fi
    printf "  (%ds) state=%s\n" "$((i*5))" "$STATE"
done

# ── Quick smoke test (from the server, localhost) ────────────────────────────
step "Smoke-testing API from inside the VM…"
$SSH "curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:8080/ || true"
$SSH "curl -sS -H 'apikey: ${API_KEY}' http://localhost:8080/instance/fetchInstances | head -c 400 || true"
echo

# ── Public reachability test (from your Mac) ────────────────────────────────
step "Smoke-testing API from your Mac (public)…"
PUBLIC_OK=true
curl -sS -o /dev/null -w "HTTP %{http_code}\n" "http://${SSH_HOST}:8080/" --max-time 10 || PUBLIC_OK=false
if [ "$PUBLIC_OK" != "true" ]; then
    c_yellow "⚠ Public port 8080 not reachable from your Mac. Likely causes:"
    echo "  - Oracle VCN Security List does not allow ingress on TCP 8080"
    echo "  - Ubuntu UFW firewall is blocking 8080"
    echo "  Fix (one of):"
    echo "    1. Oracle Console → VCN → Security Lists → add ingress TCP 8080 from 0.0.0.0/0"
    echo "    2. ssh into VM, run:  sudo ufw allow 8080/tcp  &&  sudo ufw reload"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
cat <<DONE

$(c_green "✅ Evolution API v2.3.7 is running on ${SSH_HOST}:8080")

Next steps:
  1. From your Mac, confirm the public URL responds:
       curl http://${SSH_HOST}:8080/
       curl -H 'apikey: ${API_KEY}' http://${SSH_HOST}:8080/instance/fetchInstances

  2. Open the Rozare admin dashboard → WhatsApp Verify → "Link WhatsApp".
     The backend will auto-create the instance "${INSTANCE_NAME}" and show a QR.
     Scan it with WhatsApp on your business phone.

  3. After linking, the backend auto-registers its webhook at:
       https://rozare.up.railway.app/api/whatsapp/webhook

  4. View live logs any time:
       ssh -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} 'docker logs -f evolution_api'

DONE
