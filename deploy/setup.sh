#!/usr/bin/env bash
#
# One-shot provisioning for the Kapiscout bot on a fresh Ubuntu VM.
# Safe to re-run: it updates the checkout and restarts the service.
#
#   curl -fsSL https://raw.githubusercontent.com/Aymaneerrachidi/kapiscout/full-project/deploy/setup.sh | sudo bash
#
set -euo pipefail

REPO="${REPO:-https://github.com/Aymaneerrachidi/kapiscout.git}"
BRANCH="${BRANCH:-full-project}"
APP_DIR="${APP_DIR:-/opt/kapiscout}"
APP_USER="${APP_USER:-kapiscout}"
NODE_MAJOR=22

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git python3 build-essential

# node:sqlite needs Node 22.5+, which is newer than Ubuntu's default package.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  log "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi

node_version="$(node -v)"
log "Node ${node_version}"
if ! node -e 'require("node:sqlite")' 2>/dev/null; then
  echo "This Node build lacks node:sqlite (needs >= 22.5). Got ${node_version}." >&2
  exit 1
fi

log "Creating service user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

log "Fetching source (${BRANCH})"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" remote set-url origin "$REPO"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/${BRANCH}"
else
  # Keep an existing .env if the directory was pre-seeded.
  tmp="$(mktemp -d)"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$tmp/repo"
  mv "$tmp/repo/.git" "$APP_DIR/.git"
  git -C "$APP_DIR" reset --hard
  rm -rf "$tmp"
fi

mkdir -p "$APP_DIR/data"

log "Installing dependencies and building"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
npm install --no-save --no-audit --no-fund typescript@^5.9.2 @types/node@^22.17.0
npx tsc -p tsconfig.json
test -f "$APP_DIR/dist/src/index.js" || { echo "Build produced no entrypoint." >&2; exit 1; }

if [ ! -f "$APP_DIR/.env" ]; then
  log "No .env found — writing a template"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "Edit ${APP_DIR}/.env and set TELEGRAM_BOT_TOKEN before starting."
fi

# The DB lives on the VM's persistent disk.
if ! grep -q '^DB_PATH=' "$APP_DIR/.env" 2>/dev/null; then
  echo "DB_PATH=${APP_DIR}/data/kapiscout.db" >> "$APP_DIR/.env"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

log "Installing systemd service"
install -m 644 "$APP_DIR/deploy/kapiscout.service" /etc/systemd/system/kapiscout.service
systemctl daemon-reload
systemctl enable kapiscout

if grep -q '^TELEGRAM_BOT_TOKEN=.\+' "$APP_DIR/.env"; then
  systemctl restart kapiscout
  sleep 3
  systemctl --no-pager --lines=15 status kapiscout || true
  log "Done. Logs: journalctl -u kapiscout -f"
else
  log "Set TELEGRAM_BOT_TOKEN in ${APP_DIR}/.env, then: sudo systemctl start kapiscout"
fi
