---
name: trackio
description: Self-hosted OSS experiment tracking replacing Weights & Biases (W&B) with native interactive graphs and live dashboard embedded in pi-web, plus online SQLite + GCS backups. Use whenever logging training/benchmark metrics, inspecting runs, comparing curves, querying experiment SQLite DBs, or replacing `wandb` in any codebase.
---

# Trackio (`pi-trackio`) — Self-Hosted W&B Replacement + Native `pi-web` Graphs

Trackio (`gradio-app/trackio`, MIT) runs locally on `http://127.0.0.1:30143` (`trackio.service`) with online SQLite WAL snapshots synced to Google Cloud Storage (`gs://<your-bucket>/trackio`) every 5 minutes (`trackio-backup.timer`).

**Never use Weights & Biases (`wandb`) in new code.** Always use Trackio (`import trackio as wandb`) and the `trackio_*` Pi tools.

---

## 1. Pi Tools (`pi-trackio`)

| Tool | Purpose |
|---|---|
| `trackio_plot` | Embed an interactive multi-run chart card or full Trackio Svelte dashboard directly in `pi-web` (EMA smoothing slider, log X/Y, drag-to-zoom, hover crosshair, run pills, split-screen dock) + return an ASCII sparkline summary. |
| `trackio_query` | Query projects, runs, hyperparameter configs, scalar series, system/GPU telemetry, or run read-only SQL (`action: "sql"`) against `<project>.db`. |
| `trackio_log` | Log scalar metrics and hyperparameter configs directly from Pi without spawning Python. |
| `trackio_status` | Inspect local Trackio server health, project/run counts, SQLite DBs, and GCS backup status (pass `backup_now: true` for an immediate online SQLite + GCS sync). |

### Interactive `pi-web` Cards (`trackio_plot` or ````trackio` blocks)

Calling `trackio_plot` posts a live interactive card into `pi-web`:
- **Interactive Charts tab (`mode: "chart"`)**: Native high-DPI canvas multi-run line charts with:
  - Live EMA smoothing slider (`0`–`95%`)
  - Log-Y / Log-X toggles
  - Drag-to-zoom on any subplot (`Reset zoom` button)
  - Shared step hover crosshair with per-run tooltip values
  - Run pill toggles & regex metric filter
  - `Live` 4-second auto-polling while training runs are active
- **Full Trackio UI tab (`mode: "dashboard"`)**: Embeds the full Trackio Svelte application (`/__trackio/app/`) with `Metrics`, `System`, `Runs`, `Traces`, `Media`, `Reports`, and `Artifacts` views.
- **Split-Screen Dock**: Click `Dock` on any card or the **Trackio** button in the top `pi-web` header bar to open the persistent right-hand split drawer alongside chat.

You can also emit a fenced ````trackio` block directly in Markdown responses:

````markdown
```trackio
{
  "title": "Qwen3.5-4B Decode Throughput & Loss",
  "project": "qwen35-opt",
  "runs": ["baseline-bf16", "triton-fp8-v2"],
  "metrics": ["train/loss", "eval/tok_per_s"],
  "x_axis": "step",
  "smoothing": 15,
  "mode": "chart",
  "live": true
}
```
````

---

## 2. Python SDK (`import trackio as wandb`)

```python
import trackio as wandb

run = wandb.init(
    project="my-project",
    name="exp-001",
    group="lr-sweep",
    config={"lr": 3e-4, "batch_size": 64, "model": "qwen3.5-4b"},
    resume="allow",
)

for step in range(1000):
    wandb.log({"train/loss": loss, "train/grad_norm": grad_norm, "lr": lr}, step=step)

wandb.finish()
```

### Supported Drop-In Surface
- `init`, `log`, `finish`, `log_system`, `log_gpu`, `log_cpu`, `log_artifact`, `use_artifact`, `alert`
- `Artifact`, `Image`, `Video`, `Audio`, `Table`, `Histogram`, `Plotly`, `Trace`
- Sweeps: Trackio intentionally omits `wandb.sweep` / `wandb.agent`; write sweeps as explicit Python loops or subagent fan-outs passing `group=` and `config=` to `trackio.init(...)`.

---

## 3. Remote GCP / Modal Workers

1. **Direct HTTP streaming**: Expose `127.0.0.1:30143` over SSH reverse tunnel (`ssh -R 30143:127.0.0.1:30143 ...`) or Cloudflare tunnel and set `TRACKIO_SERVER_URL` and `TRACKIO_WRITE_TOKEN` (from `~/.config/trackio.env`) on the worker. Do **not** set `TRACKIO_SPACE_ID` when using `TRACKIO_SERVER_URL`.
2. **GCS-backed sync**: On isolated workers, set `TRACKIO_DIR=/tmp/trackio` during training and sync `*.db` back to `gs://<your-bucket>/trackio/`.
