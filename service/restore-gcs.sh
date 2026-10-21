#!/usr/bin/env bash
# Restore Trackio SQLite databases, media, artifacts, and traces from GCS or a local snapshot.
#
# Usage:
#   restore-gcs.sh                           # restore from TRACKIO_GCS_BUCKET (or TRACKIO_BACKUP_DIR if unset)
#   restore-gcs.sh gs://bucket/trackio       # restore from an explicit GCS URI
#   restore-gcs.sh /path/to/backup/snapshot  # restore from a local snapshot directory
set -euo pipefail

readonly env_file="${HOME}/.config/trackio.env"
if [[ -f "${env_file}" ]]; then
  if [[ "$(stat -c '%a %u' "${env_file}")" != "600 $(id -u)" ]]; then
    echo "Refusing to source ${env_file}: must be mode 600 and owned by current user" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  source "${env_file}"
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,8p' "$0"
  exit 0
fi

readonly trackio_dir="${TRACKIO_DIR:-${HOME}/.local/share/trackio/data}"
readonly default_snap="${TRACKIO_BACKUP_DIR:-${HOME}/.local/share/trackio/backups/latest}"
source_uri="${1:-${TRACKIO_GCS_BUCKET:-${default_snap}}}"

mkdir -p "${trackio_dir}"

was_active=0
if systemctl --user is-active --quiet trackio.service 2>/dev/null; then
  was_active=1
  echo "Stopping trackio.service during restore..."
  systemctl --user stop trackio.service
fi

restore_dir="${source_uri}"
tmp_pull=""
cleanup() {
  if [[ -n "${tmp_pull}" && -d "${tmp_pull}" ]]; then
    rm -rf "${tmp_pull}"
  fi
  if (( was_active )); then
    systemctl --user start trackio.service
  fi
}
trap cleanup EXIT

if [[ "${source_uri}" == gs://* ]]; then
  if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" && -r "${GOOGLE_APPLICATION_CREDENTIALS}" ]]; then
    export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="${GOOGLE_APPLICATION_CREDENTIALS}"
  fi
  tmp_pull="$(mktemp -d "${TMPDIR:-/tmp}/trackio-restore.XXXXXX")"
  if command -v gcloud >/dev/null 2>&1; then
    gcloud storage rsync --recursive "${source_uri%/}" "${tmp_pull}"
  else
    gsutil -m rsync -r "${source_uri%/}" "${tmp_pull}"
  fi
  restore_dir="${tmp_pull}"
fi

if [[ ! -d "${restore_dir}" ]]; then
  echo "Restore source not found: ${restore_dir}" >&2
  exit 1
fi

# Remove stale WAL/SHM files before replacing .db files.
rm -f "${trackio_dir}"/*.db-wal "${trackio_dir}"/*.db-shm
rsync -a --safe-links --no-perms "${restore_dir}/" "${trackio_dir}/"

echo "restore=ok source=${source_uri} target=${trackio_dir}"
