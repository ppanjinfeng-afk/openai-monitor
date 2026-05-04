#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-}"
APP_DIR="${2:-/opt/openai-monitor}"
APP_USER="${SUDO_USER:-${USER:-root}}"
NODE_MAJOR="${NODE_MAJOR:-20}"

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: bash bootstrap-ubuntu.sh <repo-url> [app-dir]"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/7] Installing system packages..."
apt-get update
apt-get install -y curl git unzip build-essential python3 nginx ca-certificates certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1; then
  echo "[2/7] Installing Node.js ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "[2/7] Node.js already installed: $(node -v)"
fi

echo "[3/7] Installing Puppeteer runtime libraries..."
apt-get install -y \
  fonts-liberation \
  libasound2t64 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  xdg-utils

echo "[4/7] Cloning or updating project..."
mkdir -p "$APP_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

mkdir -p "$APP_DIR/data"

echo "[5/7] Installing npm dependencies..."
cd "$APP_DIR"
npm install
npx puppeteer browsers install chrome || true

echo "[6/7] Installing systemd services..."
cp "$APP_DIR/deploy/systemd/openai-monitor.service" /etc/systemd/system/openai-monitor.service
cp "$APP_DIR/deploy/systemd/openai-monitor-healthcheck.service" /etc/systemd/system/openai-monitor-healthcheck.service
cp "$APP_DIR/deploy/systemd/openai-monitor-healthcheck.timer" /etc/systemd/system/openai-monitor-healthcheck.timer
cp "$APP_DIR/deploy/systemd/openai-monitor-cdk-expire.service" /etc/systemd/system/openai-monitor-cdk-expire.service
cp "$APP_DIR/deploy/systemd/openai-monitor-cdk-expire.timer" /etc/systemd/system/openai-monitor-cdk-expire.timer
chmod +x "$APP_DIR/deploy/scripts/openai-monitor-healthcheck.sh"
systemctl daemon-reload
systemctl enable openai-monitor
systemctl enable openai-monitor-healthcheck.timer
systemctl enable openai-monitor-cdk-expire.timer

echo "[7/7] Installing nginx config..."
cp "$APP_DIR/deploy/nginx/openai-monitor.conf" /etc/nginx/sites-available/openai-monitor.conf
ln -sf /etc/nginx/sites-available/openai-monitor.conf /etc/nginx/sites-enabled/openai-monitor.conf
nginx -t
systemctl reload nginx

chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo
echo "Done."
echo "Next:"
echo "1. Upload your database to: $APP_DIR/data/monitor.db"
echo "2. Start services:"
echo "   systemctl restart openai-monitor"
echo "   systemctl start openai-monitor-healthcheck.timer"
echo "   systemctl start openai-monitor-cdk-expire.timer"
echo "3. Check status:"
echo "   systemctl status openai-monitor --no-pager"
echo "   systemctl status openai-monitor-healthcheck.timer --no-pager"
echo "   systemctl status openai-monitor-cdk-expire.timer --no-pager"
