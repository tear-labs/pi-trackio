#!/usr/bin/env bash
set -euo pipefail

readonly config_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly trackio_version="0.43.0"
readonly runtime_dir="${HOME}/.local/share/trackio"
readonly data_dir="${runtime_dir}/data"
readonly backup_dir="${runtime_dir}/backups/latest"
readonly hf_cache_dir="${HF_HOME:-${HOME}/.cache/huggingface}"
readonly hf_trackio_link="${hf_cache_dir}/trackio"
readonly user_unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
readonly agent_bin_dir="${PI_AGENT_DIR:-${HOME}/.pi/agent}/bin"
readonly env_file="${HOME}/.config/trackio.env"

mkdir -p "${runtime_dir}" "${data_dir}" "${backup_dir}" "${user_unit_dir}" "${agent_bin_dir}" "${hf_cache_dir}"

# Keep ~/.cache/huggingface/trackio symlinked to ~/.local/share/trackio/data so
# local Python processes and CLI calls that omit TRACKIO_DIR share the exact
# same database directory as trackio.service and trackio-backup.timer.
if [[ -d "${hf_trackio_link}" && ! -L "${hf_trackio_link}" ]]; then
  rsync -a "${hf_trackio_link}/" "${data_dir}/"
  rm -rf "${hf_trackio_link}"
fi
ln -sfnT "${data_dir}" "${hf_trackio_link}"

# Install trackio in an isolated pipx venv if missing or at a different version.
installed_ver="$("${HOME}/.local/bin/trackio" --version 2>/dev/null | awk '{print $2}' || true)"
if [[ "${installed_ver}" != "${trackio_version}" ]]; then
  pipx install --force "trackio[mcp,gpu]==${trackio_version}"
fi

# Expose trackio on pi's non-interactive PATH (~/.pi/agent/bin).
if [[ -x "${HOME}/.local/bin/trackio" ]]; then
  ln -sfnT "${HOME}/.local/bin/trackio" "${agent_bin_dir}/trackio"
fi

# Machine-specific token & GCS settings (kept out of git, 0600 permissions).
if [[ ! -f "${env_file}" ]]; then
  write_token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  umask 077
  cat > "${env_file}" <<EOF
# Trackio local server & GCS backup configuration (mode 0600, never committed).
TRACKIO_DIR=${data_dir}
TRACKIO_HOST=127.0.0.1
TRACKIO_PORT=30143
TRACKIO_SERVER_URL=http://127.0.0.1:30143
TRACKIO_WRITE_TOKEN=${write_token}

# Set TRACKIO_GCS_BUCKET (e.g. gs://your-bucket/trackio) to enable automatic
# 5-minute online SQLite + media + artifact backups via trackio-backup.timer.
TRACKIO_GCS_BUCKET=${TRACKIO_GCS_BUCKET:-}

# Optional: path to a GCP service-account JSON key for non-expiring unattended GCS auth.
# GOOGLE_APPLICATION_CREDENTIALS=${HOME}/.config/gcloud/trackio-backup-sa.json
EOF
  chmod 600 "${env_file}"
fi

ln -sfnT "${config_dir}/serve.py" "${runtime_dir}/serve.py"
ln -sfnT "${config_dir}/backup-gcs.sh" "${runtime_dir}/backup-gcs.sh"
ln -sfnT "${config_dir}/restore-gcs.sh" "${runtime_dir}/restore-gcs.sh"

for unit in trackio.service trackio-backup.service trackio-backup.timer; do
  ln -sfnT "${config_dir}/${unit}" "${user_unit_dir}/${unit}"
done

systemd-analyze --user verify \
  "${user_unit_dir}/trackio.service" \
  "${user_unit_dir}/trackio-backup.service" \
  "${user_unit_dir}/trackio-backup.timer"

systemctl --user daemon-reload
systemctl --user enable trackio.service trackio-backup.timer
systemctl --user restart trackio.service
systemctl --user restart trackio-backup.timer

if [[ "$(loginctl show-user "${USER}" -p Linger --value)" != "yes" ]]; then
  if sudo -n true 2>/dev/null; then
    sudo -n loginctl enable-linger "${USER}"
  else
    echo "Warning: run 'sudo loginctl enable-linger ${USER}' to keep Trackio running after logout." >&2
  fi
fi

for _ in {1..30}; do
  if curl --fail --silent --output /dev/null http://127.0.0.1:30143/version; then
    "${runtime_dir}/backup-gcs.sh" --local-only >/dev/null
    exec "${config_dir}/healthcheck.sh"
  fi
  sleep 0.5
done

journalctl --user -u trackio.service -n 50 --no-pager >&2
exit 1
