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

get_service_state() {
  systemctl show "$SERVICE_NAME" --property=ActiveState --property=SubState --value \
    | paste -sd ':' -
}

force_restart_service() {
  log_message "Force restarting ${SERVICE_NAME}"
  systemctl kill --kill-who=all "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl start "$SERVICE_NAME"
}

service_state="$(get_service_state)"
active_state="${service_state%%:*}"
sub_state="${service_state#*:}"

if [[ "$active_state" != "active" || "$sub_state" != "running" ]]; then
  log_message "${SERVICE_NAME} state is ${active_state}/${sub_state}"
  force_restart_service
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
  force_restart_service
  exit 0
fi

log_message "Health check OK"
