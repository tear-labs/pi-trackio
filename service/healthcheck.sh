#!/usr/bin/env bash
set -euo pipefail

readonly env_file="${HOME}/.config/trackio.env"
if [[ -f "${env_file}" ]]; then
  # shellcheck source=/dev/null
  source "${env_file}"
fi

readonly host="${TRACKIO_HOST:-127.0.0.1}"
readonly port="${TRACKIO_PORT:-30143}"
readonly base_url="http://${host}:${port}"

fail() {
  echo "Trackio health check failed: $*" >&2
  exit 1
}

systemctl --user is-active --quiet trackio.service \
  || fail "trackio.service is not active"

systemctl --user is-active --quiet trackio-backup.timer \
  || fail "trackio-backup.timer is not active"

service_cgroup="$(systemctl --user show trackio.service -p ControlGroup --value)"
oom_group="$(cat "/sys/fs/cgroup${service_cgroup}/memory.oom.group")"
[[ "${oom_group}" == "0" ]] \
  || fail "trackio.service is configured for whole-cgroup OOM kills"

version_body="$(
  curl \
    --silent \
    --show-error \
    --fail \
    --max-time 10 \
    "${base_url}/version"
)" || fail "${base_url}/version did not return HTTP 200"

ui_status="$(
  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --write-out '%{http_code}' \
    --max-time 10 \
    "${base_url}/"
)"
[[ "${ui_status}" == "200" ]] \
  || fail "${base_url}/ returned HTTP ${ui_status}"

systemctl --user show trackio.service \
  -p ActiveState \
  -p MainPID \
  -p MemoryCurrent \
  -p MemoryHigh \
  -p MemoryMax \
  -p OOMPolicy
echo "local_origin=http-${ui_status}"
echo "version_endpoint=${version_body}"
echo "backup_timer=active"
echo "gcs_bucket=${TRACKIO_GCS_BUCKET:-not-configured (set TRACKIO_GCS_BUCKET in ${env_file})}"
echo "oom_selection=per-process"
