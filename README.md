# pi-trackio

Self-hosted [Trackio](https://github.com/gradio-app/trackio) experiment tracking package for Pi — replacing Weights & Biases (`wandb`) with native interactive multi-run charts and the full Trackio Svelte dashboard embedded directly inside `pi-web`, backed by online SQLite WAL snapshots and Google Cloud Storage (`gs://<your-bucket>/trackio`).

## Features

- **4 Agent Tools**:
  - `trackio_plot`: Renders interactive canvas multi-run charts + full Trackio dashboard cards directly inside `pi-web` (and ASCII sparkline summaries in TUI).
  - `trackio_query`: Queries projects, runs, configs, scalar metrics, GPU/system telemetry, or executes read-only SQL against `<project>.db`.
  - `trackio_log`: Logs scalar metrics and hyperparameter configs directly from Pi.
  - `trackio_status`: Reports server health, project/run counts, SQLite DB sizes, and GCS backup status (or triggers an immediate online SQLite + GCS backup).
- **Native `pi-web` Integration**:
  - Same-origin reverse proxy at `/__trackio/app/*` and `/__trackio/*` (works over Cloudflare Access / remote tunnels with zero extra ports).
  - Automatic `TRACKIO_WRITE_TOKEN` injection so embedded dashboards are authenticated out of the box.
  - Interactive `pi-trackio-card` mounting on ````trackio` blocks with EMA smoothing slider, Log-X / Log-Y toggles, drag-to-zoom, shared step hover crosshairs, run pills, and 4s live polling.
  - Top-bar **Trackio** button + right-hand split-screen drawer (`#pi-trackio-dock`) alongside chat.
- **Zero Context Bloat**:
  - `trackio-embed` UI cards are filtered out in `pi.on("context")` so interactive visualizations never inflate LLM token context.
