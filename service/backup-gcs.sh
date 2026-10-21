#!/usr/bin/env bash
# Online WAL-safe SQLite snapshot + GCS backup for Trackio.
#
# Usage:
#   backup-gcs.sh                    # snapshot TRACKIO_DIR -> TRACKIO_BACKUP_DIR, sync to TRACKIO_GCS_BUCKET if set
#   backup-gcs.sh --local-only       # only update local consistent snapshot in TRACKIO_BACKUP_DIR
#   backup-gcs.sh --bucket gs://...  # override target GCS bucket/prefix for this run
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

local_only=0
bucket_override=""
while (($#)); do
  case "$1" in
    --local-only)
      local_only=1
      shift
      ;;
    --bucket)
      bucket_override="${2:?--bucket requires a gs:// URI}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

readonly trackio_dir="${TRACKIO_DIR:-${HOME}/.local/share/trackio/data}"
readonly snap_dir="${TRACKIO_BACKUP_DIR:-${HOME}/.local/share/trackio/backups/latest}"
gcs_bucket="${bucket_override:-${TRACKIO_GCS_BUCKET:-}}"

mkdir -p "${trackio_dir}" "${snap_dir}"

# 1. Online WAL-safe backup of every SQLite *.db in TRACKIO_DIR using Python's
# stdlib sqlite3.Connection.backup() API. Unchanged snapshots keep their mtime
# so gcloud/gsutil rsync uploads 0 bytes for idle projects.
db_stats="$(
  python3 - "${trackio_dir}" "${snap_dir}" <<'PY'
import hashlib
import os
import pathlib
import shutil
import sqlite3
import sys
import tempfile

src_dir = pathlib.Path(sys.argv[1])
dst_dir = pathlib.Path(sys.argv[2])
dst_dir.mkdir(parents=True, exist_ok=True)


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


total_dbs = 0
updated_dbs = 0
active_names: set[str] = set()

for src_db in sorted(src_dir.glob("*.db")):
    if not src_db.is_file():
        continue
    total_dbs += 1
    active_names.add(src_db.name)
    dst_db = dst_dir / src_db.name

    fd, tmp_name = tempfile.mkstemp(prefix=f".{src_db.stem}.", suffix=".db.tmp", dir=str(dst_dir))
    os.close(fd)
    tmp_path = pathlib.Path(tmp_name)
    try:
        with sqlite3.connect(f"file:{src_db}?mode=ro", uri=True, timeout=30.0) as src_conn:
            with sqlite3.connect(str(tmp_path), timeout=30.0) as dst_conn:
                src_conn.backup(dst_conn)
        # Ensure the backup file uses DELETE journal mode so it is a self-contained single file.
        with sqlite3.connect(str(tmp_path), timeout=30.0) as dst_conn:
            dst_conn.execute("PRAGMA journal_mode=DELETE;")

        if dst_db.exists() and sha256_file(dst_db) == sha256_file(tmp_path):
            tmp_path.unlink(missing_ok=True)
        else:
            os.replace(tmp_path, dst_db)
            updated_dbs += 1
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)

# Remove stale .db snapshots for deleted projects.
for old_db in dst_dir.glob("*.db"):
    if old_db.name not in active_names:
        old_db.unlink(missing_ok=True)

# Sync *.hash files preserving mtime when unchanged.
active_hashes: set[str] = set()
for src_hash in sorted(src_dir.glob("*.hash")):
    if not src_hash.is_file():
        continue
    active_hashes.add(src_hash.name)
    dst_hash = dst_dir / src_hash.name
    if not dst_hash.exists() or dst_hash.read_bytes() != src_hash.read_bytes():
        shutil.copy2(src_hash, dst_hash)

for old_hash in dst_dir.glob("*.hash"):
    if old_hash.name not in active_hashes:
        old_hash.unlink(missing_ok=True)

print(f"dbs_total={total_dbs} dbs_updated={updated_dbs}")
PY
)"

# 2. Mirror media/, artifacts/ (excluding in-flight *.partial.* blobs), traces/, and inbox/.
for subdir in media artifacts traces inbox; do
  if [[ -d "${trackio_dir}/${subdir}" ]]; then
    mkdir -p "${snap_dir}/${subdir}"
    rsync -a --delete --exclude='*.partial.*' --exclude='*.lock' \
      "${trackio_dir}/${subdir}/" "${snap_dir}/${subdir}/"
  elif [[ -d "${snap_dir}/${subdir}" ]]; then
    rm -rf "${snap_dir:?}/${subdir}"
  fi
done

date -u '+%Y-%m-%dT%H:%M:%SZ' > "${snap_dir}/.last_backup_utc"
echo "local_snapshot=ok dir=${snap_dir} ${db_stats}"

if (( local_only )); then
  echo "gcs_sync=skipped (--local-only)"
  exit 0
fi

if [[ -z "${gcs_bucket}" ]]; then
  echo "gcs_sync=skipped (TRACKIO_GCS_BUCKET unset in ${env_file})"
  exit 0
fi

if [[ "${gcs_bucket}" != gs://* ]]; then
  gcs_bucket="gs://${gcs_bucket}"
fi
gcs_bucket="${gcs_bucket%/}"

if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  if [[ ! -r "${GOOGLE_APPLICATION_CREDENTIALS}" ]]; then
    echo "GCS backup failed: GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS} is not readable" >&2
    exit 1
  fi
  export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="${GOOGLE_APPLICATION_CREDENTIALS}"
fi

if command -v gcloud >/dev/null 2>&1; then
  gcloud storage rsync --recursive --exclude='.*\.partial\..*|.*\.lock$' \
    "${snap_dir}" "${gcs_bucket}"
elif command -v gsutil >/dev/null 2>&1; then
  gsutil -m rsync -r -x '.*\.partial\..*|.*\.lock$' \
    "${snap_dir}" "${gcs_bucket}"
else
  echo "GCS backup failed: neither gcloud nor gsutil found on PATH" >&2
  exit 1
fi

echo "gcs_sync=ok uri=${gcs_bucket}"
