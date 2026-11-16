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
  - Full UI history previews default to at most 500 points per run and 4,000 across the selected runs, using Trackio's server-side sampling. Explicit `max_points` requests keep their chosen resolution; stored metrics are unchanged. The proxy also forwards the frontend-version poll used for live reload.
  - Full UI metric panels show 12 charts per page, with metric search and Previous/Next controls. Unfiltered dashboard bookmarks redirect to a core loss/CE/optimizer overview so projects with thousands of metric names cannot freeze pi-web on opening.
  - **All charts · Run activity** opens `/__trackio/charts?project=…`: one continuous, searchable canvas dashboard using the shared explorer. All chart placeholders remain in the scrollable grid, but canvases are created near the viewport and released offscreen. All project runs are included, with a bounded server-sampled preview budget. Auto-refresh touches visible plots only.
  - **Run status** in the native Full UI opens a table with a **Running only** filter. The all-charts view also shows status badges and filters for Running, Finished/stopped, and Unknown/checking. Job status is separate from metric freshness and the Auto-refresh control.
  - Worker `run.json` terminal states establish Completed/Failed/Cancelled. An exactly matched Modal app with an active worker establishes Running. A stopped app without a final worker result is **Stopped (outcome unknown)**. Active apps with no worker are labeled separately; unavailable providers and unlinked runs stay Unknown. Explicit terminal config snapshots are marked **reported**. Hover a badge for source and check time.
  - Provider checks run in the background, at most once per 30 seconds per tracked project/config set. Initial or expired checks show Checking rather than reusing stale Running labels. No jobs are launched, cancelled, or modified. Metric ages still describe logging activity only.
- **Zero Context Bloat**:
  - `trackio-embed` UI cards are filtered out in `pi.on("context")` so interactive visualizations never inflate LLM token context.

## Active compute dashboard

Open `/__trackio/compute`, use `/compute`, or call `compute_status`.
Read-only Modal, Google Cloud and SF Compute jobs link to Trackio projects.
Metric freshness is distinct from provider-reported running status.
Unlinked jobs may show weaker, non-link suggestions; confirm one by adding a `linkOverrides` entry to `~/.config/trackio-compute.json`.
Configure `~/.config/trackio-compute.json` (or `PI_TRACKIO_COMPUTE_CONFIG`):

```json
{
  "refreshSeconds": 20,
  "modal": { "cli": "/home/lev/.local/bin/modal", "environments": ["main"] },
  "gcp": { "projects": ["p1"], "zones": ["us-central1-a"], "includeTpus": true },
  "sfcompute": {
    "tokenFile": "~/.config/sfcompute.token",
    "baseUrl": "https://api.sfcompute.com",
    "instancesPath": "/preview/v2/instances",
    "workspace": "optional-workspace"
  },
  "linkOverrides": { "ap-XXXX": { "project": "MyProject", "runs": ["r1"] } }
}
```

Refresh is clamped to 10–300 seconds. TPU discovery requires explicit zones.
For expired GCP credentials, run `gcloud auth login`.
For SF Compute, run `sf login && sf tokens create --name pi-compute`;
set `SFCOMPUTE_API_TOKEN`, a token file, or the config `sfcompute.token`.
Workspace is optional; a 404 retries `/instances` once and caches the working path.

## Read-only job status adapter

Enable the local Modal reader in `~/.config/trackio-status.json`:

```json
{"modal":{"python":"/usr/bin/python3","cli":"/home/lev/.local/bin/modal","runsVolume":"simplexflow-v2-runs"}}
```

The Python interpreter must have the Modal SDK, and the CLI must already be authenticated. `PI_TRACKIO_STATUS_CONFIG` overrides this config path. Source matching uses the launch plan's exact experiment/run ID, checks the recorded commit when present, and reads only bounded `run.json` metadata from the configured volume. An explicit submission app ID also supports provider checks without a plan. Other providers and runs without a linked execution identity remain Unknown; metric silence is never converted into a job outcome.
