# trackio-service

Local [Trackio](https://github.com/gradio-app/trackio) (`v0.43.0`, MIT) server and
online GCS backup pipeline, replacing Weights & Biases (`wandb`).

## Layout

| File | Purpose |
|---|---|
| `setup.sh` | Installs `trackio[mcp,gpu]==0.43.0` via `pipx`, seeds `~/.config/trackio.env` (`0600`), links `~/.cache/huggingface/trackio` -> `~/.local/share/trackio/data`, enables `trackio.service` + `trackio-backup.timer`, and runs `healthcheck.sh` |
| `serve.py` | Launches Trackio dashboard + API + MCP (`/mcp`) on `127.0.0.1:30143` without opening a browser or leaking `TRACKIO_WRITE_TOKEN` into `journald` |
| `trackio.service` | OOM-isolated systemd user service (`MemoryHigh=2G`, `MemoryMax=4G`, `OOMPolicy=continue`) |
| `backup-gcs.sh` | Takes online WAL-safe SQLite snapshots (`sqlite3.Connection.backup`) into `~/.local/share/trackio/backups/latest`, mirrors `*.hash`, `media/`, `artifacts/`, `traces/`, and `inbox/`, and syncs to `$TRACKIO_GCS_BUCKET` |
| `restore-gcs.sh` | Restores `TRACKIO_DIR` from `$TRACKIO_GCS_BUCKET` (or a local snapshot path) |
| `trackio-backup.service` / `.timer` | Runs `backup-gcs.sh` every 5 minutes (`OnUnitActiveSec=5min`, `Persistent=true`) |
| `healthcheck.sh` | Verifies unit state, per-process OOM cgroup config, `/version`, `/`, and backup timer |

## Setup & verification

```bash
bash ~/code/pi-setup/web/trackio-service/setup.sh
bash ~/code/pi-setup/web/trackio-service/healthcheck.sh
```

## Enabling GCS backups

1. Authenticate `gcloud` (or configure a service-account key for unattended timer runs):
   ```bash
   gcloud auth login
   # Optional: create a bucket if you don't already have one
   gcloud storage buckets create gs://YOUR-BUCKET --project=YOUR-GCP-PROJECT --location=us-central1
   ```
2. Set `TRACKIO_GCS_BUCKET` in `~/.config/trackio.env`:
   ```ini
   TRACKIO_GCS_BUCKET=gs://YOUR-BUCKET/trackio
   # Optional non-expiring service-account key for background timer runs:
   # GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/gcloud/trackio-backup-sa.json
   ```
3. Test an immediate backup:
   ```bash
   ~/.local/share/trackio/backup-gcs.sh
   ```
