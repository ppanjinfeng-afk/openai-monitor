#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-openai-monitor}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/admin-login}"
HEALTHCHECK_TIMEOUT_SECONDS="${HEALTHCHECK_TIMEOUT_SECONDS:-8}"
LOG_TAG="${LOG_TAG:-openai-monitor-healthcheck}"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found" >&2
  exit 1
fi

log_message() {
  local message="$1"
  if command -v logger >/dev/null 2>&1; then
    logger -t "$LOG_TAG" "$message"
  fi
  echo "[$LOG_TAG] $message"
}

restart_service() {
  log_message "Restarting ${SERVICE_NAME}"
  systemctl restart "$SERVICE_NAME"
}

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  log_message "${SERVICE_NAME} is not active"
  restart_service
  exit 0
fi

if ! curl \
  --silent \
  --show-error \
  --location \
  --max-time "$HEALTHCHECK_TIMEOUT_SECONDS" \
  --output /dev/null \
  "$HEALTH_URL"; then
  log_message "Health check failed for ${HEALTH_URL}"
  restart_service
  exit 0
fi

log_message "Health check OK"
