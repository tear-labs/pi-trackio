// =============================================================================
// pi-trackio browser bootstrap for pi-web
//
// Provides:
//   1. True split-screen Trackio side panel (#pi-trackio-dock) mounted beside
//      the chat column inside pi-web's flex layout (next to #file-panel), with:
//        - "📈 Loss & Curves" view (native high-DPI per-run loss/CE/eval/perf
//          charts, Run Focus selector, Metric Group tabs, Per-Run breakdown table)
//        - "🧭 Full Trackio UI" view (full Trackio Svelte app for Metrics,
//          System/GPU, Runs, Traces, Media, Reports, Artifacts)
//        - Draggable split-screen resize handle, Cite View, and GCS Backup.
//   2. Clickable Trackio links in chat messages (/__trackio/app...,
//      http://127.0.0.1:30143..., trackio://...) that pull up the exact project
//      and run directly in the split-screen local dashboard.
//   3. Inline interactive multi-run charts (<canvas>) & embedded Trackio Svelte
//      dashboards inside pi-web chat messages (any ```trackio code block or
//      trackio-embed custom message).
// =============================================================================
(function () {
  "use strict";

  const VERSION = "trackio-v6";
  const versionOf = (value) => Number(/v(\d+)/.exec(String(value ?? ""))?.[1] ?? 0);
  const previous = window.__piTrackioEntryVersion;
  if (previous && versionOf(previous) >= versionOf(VERSION)) return;
  window.__piTrackioEntryVersion = VERSION;

  if (window.location.pathname.startsWith("/__trackio/app")) return;

  if (previous) {
    for (const node of document.querySelectorAll("#pi-web-trackio-toolbar, #pi-trackio-dock, #pi-trackio-style")) {
      node.remove();
    }
  }

  const TOOLBAR_ID = "pi-web-trackio-toolbar";
  const DOCK_ID = "pi-trackio-dock";
  const STYLE_ID = "pi-trackio-style";

  const PALETTE = [
    "#f97316", // orange
    "#38bdf8", // sky
    "#a855f7", // purple
    "#22c55e", // green
    "#f43f5e", // rose
    "#eab308", // yellow
    "#14b8a6", // teal
    "#ec4899", // pink
    "#6366f1", // indigo
    "#84cc16", // lime
  ];

  function escHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch,
    );
  }

  function safeMatchMetric(metricName, rawPat) {
    const pat = String(rawPat ?? "").trim().slice(0, 120);
    if (!pat) return true;
    if (pat === metricName) return true;
    if (/(\*|\+|\{[0-9,]+\})\s*\)[*+?]/.test(pat)) {
      return metricName.toLowerCase().includes(pat.toLowerCase());
    }
    try {
      return new RegExp(pat, "i").test(metricName);
    } catch {
      return metricName.toLowerCase().includes(pat.toLowerCase());
    }
  }

  function metricPriority(metricName) {
    const m = String(metricName || "").toLowerCase();
    if (m === "loss" || m === "train/loss" || m === "train/ce" || m === "ce") return 0;
    if (
      m === "val/loss" ||
      m === "eval/loss" ||
      m === "val/ce" ||
      m === "val/ce_student" ||
      m === "eval/heldout_ce" ||
      m === "eval/heldout/fixed_t_ce"
    ) {
      return 1;
    }
    if (/(?:^|\/)(?:loss|ce|nll|ppl|perplexity)(?:$|\/|_)/i.test(m) && !m.startsWith("time/")) return 2;
    if (
      /(?:^|\/)(?:kl|rkl|top1_agree|acc|accuracy|auroc|win_rate|is_human|mean|coherence|score|reward)(?:$|\/|_)/i.test(
        m,
      )
    ) {
      return 3;
    }
    if (/(?:^|\/)(?:grad_norm|lr|learning_rate|update_rms)(?:$|\/|_)/i.test(m)) return 4;
    if (
      /(?:^|\/)(?:tok_per_s|target_tokens_per_second|mfu|update_seconds|step_time|mem_gb|peak_memory)(?:$|\/|_)/i.test(
        m,
      )
    ) {
      return 5;
    }
    if (m.startsWith("train/") || m.startsWith("val/") || m.startsWith("eval/")) return 6;
    if (m.startsWith("perf/") || m.startsWith("opt/") || m.startsWith("ffn_opt/")) return 7;
    return 10;
  }

  function isCoreMetric(metricName) {
    return metricPriority(metricName) <= 5;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .pi-trackio-card {
      border: 1px solid var(--border, rgba(150, 190, 255, 0.16));
      border-radius: 12px;
      background: var(--bg-panel, rgba(16, 26, 51, 0.72));
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      color: var(--text, #f1f5ff);
      margin: 10px 0;
      overflow: hidden;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
      font-family: system-ui, -apple-system, sans-serif;
    }
    .pi-trackio-header {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border, rgba(150, 190, 255, 0.14));
      background: rgba(255, 255, 255, 0.03);
      font-size: 12px;
    }
    .pi-trackio-brand {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 650;
      color: var(--text, #f1f5ff);
      letter-spacing: 0.01em;
    }
    .pi-trackio-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f97316;
      box-shadow: 0 0 8px rgba(249, 115, 22, 0.75);
      display: inline-block;
      flex-shrink: 0;
    }
    .pi-trackio-live {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 600;
      border: 1px solid rgba(34, 197, 94, 0.35);
      background: rgba(34, 197, 94, 0.12);
      color: #4ade80;
      cursor: pointer;
      user-select: none;
    }
    .pi-trackio-live.is-paused {
      border-color: var(--border, rgba(150, 190, 255, 0.2));
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-dim, #a2b2d4);
    }
    .pi-trackio-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border, rgba(150, 190, 255, 0.11));
      background: rgba(0, 0, 0, 0.14);
      font-size: 11px;
    }
    .pi-trackio-select, .pi-trackio-btn {
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(150, 190, 255, 0.18));
      background: var(--bg-subtle, rgba(255, 255, 255, 0.05));
      color: var(--text, #f1f5ff);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .pi-trackio-btn:hover, .pi-trackio-select:hover {
      background: var(--bg-hover, rgba(255, 255, 255, 0.1));
    }
    .pi-trackio-btn.is-active {
      border-color: #f97316;
      background: rgba(249, 115, 22, 0.18);
      color: #fff;
    }
    .pi-trackio-runs-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border, rgba(150, 190, 255, 0.1));
      font-size: 11px;
    }
    .pi-trackio-run-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(150, 190, 255, 0.18));
      background: rgba(255, 255, 255, 0.04);
      color: var(--text, #f1f5ff);
      cursor: pointer;
      font-size: 11px;
      user-select: none;
      transition: opacity 0.12s, border-color 0.12s;
    }
    .pi-trackio-run-chip.is-solo {
      border-color: #f97316;
      background: rgba(249, 115, 22, 0.16);
    }
    .pi-trackio-run-chip.is-off {
      opacity: 0.35;
      text-decoration: line-through;
    }
    .pi-trackio-swatch {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .pi-trackio-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(275px, 1fr));
      gap: 10px;
      padding: 10px;
    }
    .pi-trackio-plot-box {
      position: relative;
      border: 1px solid var(--border, rgba(150, 190, 255, 0.13));
      border-radius: 8px;
      background: rgba(5, 9, 20, 0.42);
      padding: 8px 8px 4px 8px;
      min-height: 210px;
      display: flex;
      flex-direction: column;
    }
    .pi-trackio-plot-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 600;
      font-family: var(--font-mono, monospace);
      color: var(--text, #f1f5ff);
      margin-bottom: 4px;
      padding: 0 2px;
    }
    .pi-trackio-plot-sub {
      font-size: 10px;
      font-weight: 400;
      color: var(--text-dim, #a2b2d4);
      white-space: nowrap;
    }
    .pi-trackio-canvas-wrap {
      position: relative;
      flex: 1;
      width: 100%;
      height: 180px;
      cursor: crosshair;
      user-select: none;
    }
    .pi-trackio-canvas-wrap canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    .pi-trackio-tooltip {
      position: absolute;
      z-index: 20;
      pointer-events: none;
      background: rgba(10, 14, 26, 0.94);
      border: 1px solid rgba(150, 190, 255, 0.24);
      border-radius: 7px;
      padding: 6px 8px;
      font-size: 11px;
      font-family: var(--font-mono, monospace);
      color: #f1f5ff;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
      white-space: nowrap;
      display: none;
    }
    .pi-trackio-summary-wrap {
      border-top: 1px solid var(--border, rgba(150, 190, 255, 0.12));
      padding: 6px 10px 10px;
      font-size: 11px;
      overflow-x: auto;
    }
    .pi-trackio-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
    }
    .pi-trackio-table th, .pi-trackio-table td {
      padding: 4px 7px;
      text-align: left;
      border-bottom: 1px solid rgba(150, 190, 255, 0.08);
      white-space: nowrap;
    }
    .pi-trackio-table th {
      color: var(--text-dim, #a2b2d4);
      font-weight: 600;
    }
    .pi-trackio-iframe-wrap {
      width: 100%;
      height: 540px;
      border: none;
      background: var(--bg, #0d1326);
      position: relative;
    }
    .pi-trackio-iframe-wrap iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }
    /* Split-screen side panel inside pi-web's main horizontal flex layout */
    #${DOCK_ID} {
      position: relative;
      flex-shrink: 0;
      width: var(--trackio-dock-width, clamp(440px, 48vw, 820px));
      min-width: 340px;
      max-width: 86vw;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--warp-solid, var(--bg-panel, #0d1326));
      color: var(--text, #f1f5ff);
      border-left: 1px solid var(--border, rgba(150, 190, 255, 0.2));
      backdrop-filter: blur(22px) saturate(140%);
      -webkit-backdrop-filter: blur(22px) saturate(140%);
      font-family: system-ui, -apple-system, sans-serif;
      z-index: 40;
      overflow: hidden;
    }
    #${DOCK_ID}.is-maximized {
      width: min(1240px, 76vw) !important;
    }
    @media (max-width: 959px) {
      #${DOCK_ID} {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(680px, 95vw) !important;
        z-index: 9500;
        box-shadow: -12px 0 36px rgba(0, 0, 0, 0.55);
      }
    }
    #${DOCK_ID} .pi-trackio-dock-resize {
      position: absolute;
      left: -4px;
      top: 0;
      bottom: 0;
      width: 8px;
      cursor: ew-resize;
      z-index: 10;
    }
    #${DOCK_ID} .pi-trackio-dock-resize:hover,
    #${DOCK_ID} .pi-trackio-dock-resize.is-dragging {
      background: linear-gradient(180deg, #f97316, #38bdf8);
      opacity: 0.85;
    }
    #${DOCK_ID} .pi-trackio-dock-scroll {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
    }
    a.pi-trackio-dashboard-link {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 1px 8px;
      border-radius: 6px;
      border: 1px solid rgba(249, 115, 22, 0.42);
      background: rgba(249, 115, 22, 0.14);
      color: #fb923c !important;
      font-weight: 550;
      text-decoration: none !important;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    a.pi-trackio-dashboard-link:hover {
      background: rgba(249, 115, 22, 0.25);
      border-color: #f97316;
      color: #fff !important;
    }
    .pi-trackio-ext-tab {
      display: inline-flex;
      align-items: center;
      margin-left: 4px;
      padding: 1px 5px;
      border-radius: 5px;
      border: 1px solid var(--border, rgba(150, 190, 255, 0.22));
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-dim, #a2b2d4) !important;
      font-size: 10.5px;
      text-decoration: none !important;
      vertical-align: middle;
    }
    .pi-trackio-ext-tab:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #fff !important;
    }
  `;
  document.head.append(style);

  function currentThemeParam() {
    const t = document.documentElement.dataset.theme || "";
    const skin = document.documentElement.dataset.skinPalette || "";
    if (skin === "warp" || t === "dark" || t === "pine" || !t) return "dark";
    if (t === "light" || t === "mist" || t === "rose") return "default";
    return "dark";
  }

  function buildTrackioAppUrl(spec = {}) {
    const pageMap = {
      metrics: "/",
      system: "/system",
      traces: "/traces",
      media: "/media",
      reports: "/reports",
      runs: "/runs",
      "run-detail": "/run",
      files: "/files",
      artifacts: "/artifacts",
      settings: "/settings",
    };
    const pagePath = pageMap[spec.page || "metrics"] || "/";
    const params = new URLSearchParams();
    if (spec.project) params.set("project", spec.project);
    const activeRuns = spec.soloRun ? [spec.soloRun] : spec.runs;
    if (Array.isArray(activeRuns) && activeRuns.length > 0) {
      params.set("runs", activeRuns.join(","));
    }
    if (Array.isArray(spec.metrics) && spec.metrics.length > 0) {
      params.set("metrics", spec.metrics.join(","));
    } else if (spec.metricFilter) {
      params.set("metric_filter", spec.metricFilter);
    }
    if (spec.xAxis && spec.xAxis !== "step") params.set("x_axis", spec.xAxis);
    if (spec.smoothing != null) params.set("smoothing", String(spec.smoothing));
    if (spec.sidebar) params.set("sidebar", spec.sidebar);
    if (spec.navbar) params.set("navbar", spec.navbar);
    params.set("__theme", currentThemeParam());
    const qs = params.toString();
    return `/__trackio/app${pagePath}${qs ? `?${qs}` : ""}`;
  }

  function parseTrackioLinkHref(rawHref) {
    if (!rawHref) return null;
    try {
      if (rawHref.startsWith("trackio://")) {
        const u = new URL(rawHref.replace(/^trackio:\/\//, "http://trackio.local/"));
        const project =
          decodeURIComponent(u.pathname.replace(/^\/+/, "")) ||
          u.searchParams.get("project") ||
          u.searchParams.get("selected_project") ||
          "";
        const runs = (u.searchParams.get("runs") || "").split(",").filter(Boolean);
        return {
          project,
          runs,
          soloRun: runs.length === 1 ? runs[0] : "",
          metrics: (u.searchParams.get("metrics") || "").split(",").filter(Boolean),
          page: u.searchParams.get("page") || "metrics",
          xAxis: u.searchParams.get("x_axis") || undefined,
          smoothing: u.searchParams.has("smoothing") ? Number(u.searchParams.get("smoothing")) : undefined,
        };
      }
      const u = new URL(rawHref, window.location.origin);
      const isLocalTrackio =
        (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "30143";
      const isProxiedTrackio = u.pathname === "/__trackio" || u.pathname.startsWith("/__trackio/");
      if (!isLocalTrackio && !isProxiedTrackio) return null;

      const rawPage = isProxiedTrackio
        ? u.pathname.replace(/^\/__trackio(?:\/app)?\/?/, "").replace(/^\/+/, "")
        : u.pathname.replace(/^\/+/, "");
      const runs = (u.searchParams.get("runs") || u.searchParams.get("selected_run") || "")
        .split(",")
        .filter(Boolean);
      return {
        project: u.searchParams.get("project") || u.searchParams.get("selected_project") || "",
        runs,
        soloRun: runs.length === 1 ? runs[0] : "",
        metrics: (u.searchParams.get("metrics") || "").split(",").filter(Boolean),
        page: rawPage || "metrics",
        xAxis: u.searchParams.get("x_axis") || undefined,
        smoothing: u.searchParams.has("smoothing") ? Number(u.searchParams.get("smoothing")) : undefined,
      };
    } catch {
      return null;
    }
  }

  function insertIntoChatComposer(text) {
    const textarea =
      document.querySelector("textarea[placeholder]") ||
      document.querySelector("form textarea") ||
      document.querySelector("textarea");
    if (!textarea) {
      navigator.clipboard?.writeText(text).catch(() => {});
      return false;
    }
    const current = textarea.value || "";
    const next = current ? `${current.replace(/\s+$/, "")}\n${text}\n` : `${text}\n`;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(textarea, next);
    else textarea.value = next;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    return true;
  }

  function requestIframeViewState(iframe, timeoutMs = 1500) {
    return new Promise((resolve) => {
      if (!iframe || !iframe.contentWindow) return resolve(null);
      const reqId = `pi-trk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const expectedOrigin = window.location.origin;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(null);
      }, timeoutMs);
      function onMsg(event) {
        if (event.origin !== expectedOrigin || event.source !== iframe.contentWindow) return;
        const msg = event.data;
        if (!msg || msg.protocol !== "trackio-view" || msg.id !== reqId) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(msg.state || null);
      }
      window.addEventListener("message", onMsg);
      iframe.contentWindow.postMessage(
        { protocol: "trackio-view", version: 1, type: "getState", id: reqId },
        expectedOrigin,
      );
    });
  }

  function formatNum(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    const abs = Math.abs(v);
    if (abs === 0) return "0";
    if (abs < 0.001 || abs >= 100000) return v.toExponential(3);
    if (abs < 1) return v.toFixed(4);
    if (abs < 100) return v.toFixed(3);
    return v.toFixed(2);
  }

  const _seriesCache = new Map();
  const _seriesInFlight = new Map();

  async function callTrackioApi(endpoint, body = {}) {
    const res = await fetch(`/__trackio/app/api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-trackio": "1" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json?.error) throw new Error(json.error);
    return json?.data;
  }

  async function fetchSeriesDirect(params = {}) {
    const key = JSON.stringify({
      p: params.project || "",
      r: params.runs || null,
      x: params.xAxis || "step",
    });
    const now = Date.now();
    const cached = _seriesCache.get(key);
    if (cached && now - cached.ts < 1500) return cached.data;
    if (_seriesInFlight.has(key)) return _seriesInFlight.get(key);

    const job = (async () => {
      const allProjectsRaw = await callTrackioApi("get_all_projects", {});
      const allProjects = Array.isArray(allProjectsRaw) ? allProjectsRaw : [];
      const reqProj = String(params.project || "").trim();
      const project =
        allProjects.find((p) => p === reqProj) ||
        allProjects.find((p) => p.toLowerCase() === reqProj.toLowerCase()) ||
        allProjects[0] ||
        "";
      if (!project) {
        return {
          project: "",
          allProjects: [],
          allRuns: [],
          selectedRuns: [],
          availableMetrics: [],
          selectedMetrics: [],
          xAxis: params.xAxis || "step",
          series: [],
        };
      }

      const rawRuns = await callTrackioApi("get_runs_for_project", { project });
      const allRuns = Array.isArray(rawRuns)
        ? [...rawRuns]
            .reverse()
            .map((r) => (typeof r === "string" ? r : r?.name))
            .filter(Boolean)
        : [];

      const wantedRuns =
        Array.isArray(params.runs) && params.runs.length > 0
          ? allRuns.filter((r) => params.runs.includes(r))
          : allRuns.slice(0, 12);
      const selectedRuns = wantedRuns.length > 0 ? wantedRuns : allRuns.slice(0, 12);

      const batch =
        selectedRuns.length > 0
          ? await callTrackioApi("get_logs_batch", {
              project,
              runs: selectedRuns.map((r) => ({ run: r, run_id: null })),
              max_points: 220,
              scalar_only: true,
            })
          : [];

      const xAxis = params.xAxis || "step";
      const reserved = new Set(["step", "time", "timestamp", "_step", "_timestamp", "run"]);
      const metricSet = new Set();

      const series = (Array.isArray(batch) ? batch : []).map((entry, idx) => {
        const runName = entry.run;
        const colorIndex = Math.max(0, allRuns.indexOf(runName));
        const logs = Array.isArray(entry.logs) ? entry.logs : [];
        const metricsMap = {};
        const latest = {};
        const min = {};
        const max = {};

        for (let i = 0; i < logs.length; i++) {
          const row = logs[i];
          if (!row || typeof row !== "object") continue;
          const stepVal =
            typeof row[xAxis] === "number" && Number.isFinite(row[xAxis])
              ? row[xAxis]
              : typeof row.step === "number" && Number.isFinite(row.step)
                ? row.step
                : i;
          for (const [k, v] of Object.entries(row)) {
            if (reserved.has(k)) continue;
            if (typeof v !== "number" || !Number.isFinite(v)) continue;
            metricSet.add(k);
            if (!metricsMap[k]) metricsMap[k] = [];
            metricsMap[k].push({ step: stepVal, value: v });
            latest[k] = v;
            min[k] = min[k] === undefined ? v : Math.min(min[k], v);
            max[k] = max[k] === undefined ? v : Math.max(max[k], v);
          }
        }

        for (const pts of Object.values(metricsMap)) {
          pts.sort((a, b) => a.step - b.step);
        }

        return {
          run: runName,
          colorIndex: colorIndex >= 0 ? colorIndex : idx,
          metrics: metricsMap,
          latest,
          min,
          max,
        };
      });

      const availableMetrics = [...metricSet].sort((a, b) => {
        const pa = metricPriority(a);
        const pb = metricPriority(b);
        return pa !== pb ? pa - pb : a.localeCompare(b);
      });

      const out = {
        project,
        allProjects,
        allRuns,
        selectedRuns,
        availableMetrics,
        selectedMetrics: availableMetrics,
        xAxis,
        series,
      };
      _seriesCache.set(key, { ts: Date.now(), data: out });
      return out;
    })()
      .catch((err) => {
        if (cached) return cached.data;
        throw err;
      })
      .finally(() => {
        _seriesInFlight.delete(key);
      });

    _seriesInFlight.set(key, job);
    return job;
  }

  function computeEma(points, weight) {
    if (!points.length || weight <= 0) return points.map((p) => p.value);
    const alpha = Math.min(0.98, Math.max(0, weight));
    const out = new Array(points.length);
    let last = points[0].value;
    for (let i = 0; i < points.length; i++) {
      last = last * alpha + points[i].value * (1 - alpha);
      out[i] = last;
    }
    return out;
  }

  // --- Interactive Canvas Plot Renderer --------------------------------------
  function renderMetricPlot(plotBox, metricName, state, onHoverStep, onZoomRange) {
    const wrap = plotBox.querySelector(".pi-trackio-canvas-wrap");
    const canvas = wrap.querySelector("canvas");
    const tooltip = wrap.querySelector(".pi-trackio-tooltip");
    const subLabel = plotBox.querySelector(".pi-trackio-plot-sub");
    if (!canvas || !wrap) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    const width = Math.max(220, Math.floor(rect.width || 300));
    const height = Math.max(140, Math.floor(rect.height || 175));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const padL = 48;
    const padR = 12;
    const padT = 10;
    const padB = 22;
    const plotW = Math.max(40, width - padL - padR);
    const plotH = Math.max(40, height - padT - padB);

    const activeSeries = (state.data?.series || []).filter((s) => {
      if (state.soloRun && s.run !== state.soloRun) return false;
      if (!state.soloRun && state.disabledRuns.has(s.run)) return false;
      return Array.isArray(s.metrics?.[metricName]) && s.metrics[metricName].length > 0;
    });

    if (activeSeries.length === 0) {
      ctx.fillStyle = "rgba(162, 178, 212, 0.6)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data points for " + metricName, width / 2, height / 2);
      ctx.restore();
      return;
    }

    const smoothingWeight = Math.min(0.95, Math.max(0, (state.smoothing || 0) / 100));
    const prepared = activeSeries
      .map((s) => {
        let pts = s.metrics[metricName];
        if (state.xRange) {
          pts = pts.filter((p) => p.step >= state.xRange[0] && p.step <= state.xRange[1]);
        }
        const smoothed = computeEma(pts, smoothingWeight);
        return {
          run: s.run,
          color: PALETTE[s.colorIndex % PALETTE.length],
          pts,
          smoothed,
        };
      })
      .filter((s) => s.pts.length > 0);

    if (prepared.length === 0) {
      ctx.restore();
      return;
    }

    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;

    for (const s of prepared) {
      for (let i = 0; i < s.pts.length; i++) {
        const xv = state.logX ? (s.pts[i].step > 0 ? Math.log10(s.pts[i].step) : null) : s.pts[i].step;
        const rawY = s.pts[i].value;
        const smY = s.smoothed[i];
        const yv = state.logY ? (smY > 0 ? Math.log10(smY) : null) : smY;
        const yvRaw = state.logY ? (rawY > 0 ? Math.log10(rawY) : null) : rawY;
        if (xv !== null && Number.isFinite(xv)) {
          if (xv < xMin) xMin = xv;
          if (xv > xMax) xMax = xv;
        }
        if (yv !== null && Number.isFinite(yv)) {
          if (yv < yMin) yMin = yv;
          if (yv > yMax) yMax = yv;
        }
        if (yvRaw !== null && Number.isFinite(yvRaw) && smoothingWeight < 0.85) {
          if (yvRaw < yMin) yMin = yvRaw;
          if (yvRaw > yMax) yMax = yvRaw;
        }
      }
    }

    if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) {
      ctx.restore();
      return;
    }
    if (xMin === xMax) {
      xMin -= 1;
      xMax += 1;
    }
    if (yMin === yMax) {
      const delta = Math.abs(yMin) * 0.1 || 1;
      yMin -= delta;
      yMax += delta;
    } else {
      const pad = (yMax - yMin) * 0.06;
      yMin -= pad;
      yMax += pad;
    }

    const toX = (step) => {
      const xv = state.logX ? Math.log10(Math.max(1e-9, step)) : step;
      return padL + ((xv - xMin) / (xMax - xMin)) * plotW;
    };
    const toY = (val) => {
      const yv = state.logY ? Math.log10(Math.max(1e-12, val)) : val;
      return padT + plotH - ((yv - yMin) / (yMax - yMin)) * plotH;
    };

    ctx.strokeStyle = "rgba(150, 190, 255, 0.10)";
    ctx.fillStyle = "rgba(162, 178, 212, 0.72)";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.lineWidth = 1;

    const yTicks = 4;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= yTicks; i++) {
      const frac = i / yTicks;
      const py = padT + plotH - frac * plotH;
      const val = state.logY ? Math.pow(10, yMin + frac * (yMax - yMin)) : yMin + frac * (yMax - yMin);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();
      ctx.fillText(formatNum(val), padL - 5, py);
    }

    const xTicks = 4;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= xTicks; i++) {
      const frac = i / xTicks;
      const px = padL + frac * plotW;
      const val = state.logX ? Math.pow(10, xMin + frac * (xMax - xMin)) : xMin + frac * (xMax - xMin);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.fillText(String(Math.round(val * 100) / 100), px, padT + plotH + 5);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();

    for (const s of prepared) {
      if (smoothingWeight > 0.01 && s.pts.length > 2) {
        ctx.strokeStyle = s.color + "38";
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < s.pts.length; i++) {
          if ((state.logX && s.pts[i].step <= 0) || (state.logY && s.pts[i].value <= 0)) continue;
          const px = toX(s.pts[i].step);
          const py = toY(s.pts[i].value);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }

      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.pts.length === 1 ? 0 : 2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.pts.length; i++) {
        const yVal = s.smoothed[i];
        if ((state.logX && s.pts[i].step <= 0) || (state.logY && yVal <= 0)) continue;
        const px = toX(s.pts[i].step);
        const py = toY(yVal);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();

      const lastIdx = s.pts.length - 1;
      if (lastIdx >= 0) {
        const lastPt = s.pts[lastIdx];
        const lastY = s.smoothed[lastIdx];
        if ((!state.logX || lastPt.step > 0) && (!state.logY || lastY > 0)) {
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(toX(lastPt.step), toY(lastY), s.pts.length === 1 ? 4 : 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (plotBox.__dragStartX != null && plotBox.__dragCurX != null) {
      const x0 = Math.max(padL, Math.min(padL + plotW, Math.min(plotBox.__dragStartX, plotBox.__dragCurX)));
      const x1 = Math.max(padL, Math.min(padL + plotW, Math.max(plotBox.__dragStartX, plotBox.__dragCurX)));
      ctx.fillStyle = "rgba(56, 189, 248, 0.18)";
      ctx.fillRect(x0, padT, x1 - x0, plotH);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.75)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, padT, x1 - x0, plotH);
    }

    if (state.hoverStep !== null && state.hoverStep !== undefined) {
      const hx = toX(state.hoverStep);
      if (hx >= padL && hx <= padL + plotW) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.38)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        const rows = [];
        for (const s of prepared) {
          let bestIdx = 0;
          let bestDist = Infinity;
          for (let i = 0; i < s.pts.length; i++) {
            const d = Math.abs(s.pts[i].step - state.hoverStep);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = i;
            }
          }
          const pt = s.pts[bestIdx];
          const sm = s.smoothed[bestIdx];
          if (pt) {
            const px = toX(pt.step);
            const py = toY(sm);
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(px, py, 3.8, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#0a0e1a";
            ctx.lineWidth = 1.2;
            ctx.stroke();
            rows.push({
              run: s.run,
              color: s.color,
              step: pt.step,
              val: sm,
              raw: pt.value,
            });
          }
        }

        if (rows.length > 0 && tooltip) {
          tooltip.style.display = "block";
          tooltip.innerHTML =
            `<div style="color:#a2b2d4;margin-bottom:3px">step ${escHtml(rows[0].step)}</div>` +
            rows
              .map(
                (r) =>
                  `<div style="display:flex;align-items:center;gap:6px">` +
                  `<span style="width:7px;height:7px;border-radius:50%;background:${escHtml(r.color)};display:inline-block"></span>` +
                  `<span style="color:#cbd5e1">${escHtml(r.run)}:</span>` +
                  `<b style="color:#fff">${escHtml(formatNum(r.val))}</b>` +
                  (smoothingWeight > 0.01
                    ? `<span style="color:#94a3b8;font-size:10px">(raw ${escHtml(formatNum(r.raw))})</span>`
                    : "") +
                  `</div>`,
              )
              .join("");
          const tipLeft =
            hx + 12 + tooltip.offsetWidth > width ? Math.max(4, hx - tooltip.offsetWidth - 10) : hx + 12;
          tooltip.style.left = `${Math.round(tipLeft)}px`;
          tooltip.style.top = `${padT + 4}px`;
        }
      } else if (tooltip) {
        tooltip.style.display = "none";
      }
    } else if (tooltip) {
      tooltip.style.display = "none";
    }

    ctx.restore();
    ctx.restore();

    if (subLabel) {
      const latestRun = prepared[0];
      const firstPt = latestRun?.pts[0];
      const lastPt = latestRun?.pts[latestRun.pts.length - 1];
      if (lastPt) {
        const deltaStr =
          firstPt && latestRun.pts.length > 1
            ? ` (Δ ${lastPt.value - firstPt.value >= 0 ? "+" : ""}${formatNum(lastPt.value - firstPt.value)})`
            : "";
        subLabel.textContent = `${formatNum(lastPt.value)} @ s${lastPt.step}${deltaStr}`;
      } else {
        subLabel.textContent = "";
      }
    }

    if (!canvas.__piBound) {
      canvas.__piBound = true;
      const xFromEvent = (ev) => {
        const r = canvas.getBoundingClientRect();
        return ev.clientX - r.left;
      };
      const stepFromPx = (px) => {
        const st = plotBox.__plotBounds;
        if (!st) return null;
        const frac = Math.max(0, Math.min(1, (px - st.padL) / st.plotW));
        const xv = st.xMin + frac * (st.xMax - st.xMin);
        return st.logX ? Math.pow(10, xv) : xv;
      };
      canvas.addEventListener("pointermove", (ev) => {
        const px = xFromEvent(ev);
        if (plotBox.__dragStartX != null) {
          plotBox.__dragCurX = px;
        }
        const step = stepFromPx(px);
        if (step !== null) onHoverStep(step);
      });
      canvas.addEventListener("pointerleave", () => {
        if (plotBox.__dragStartX == null) onHoverStep(null);
      });
      canvas.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        plotBox.__dragStartX = xFromEvent(ev);
        plotBox.__dragCurX = plotBox.__dragStartX;
      });
      window.addEventListener("pointerup", () => {
        if (plotBox.__dragStartX == null) return;
        const x0 = plotBox.__dragStartX;
        const x1 = plotBox.__dragCurX ?? x0;
        plotBox.__dragStartX = null;
        plotBox.__dragCurX = null;
        if (Math.abs(x1 - x0) > 10) {
          const s0 = stepFromPx(Math.min(x0, x1));
          const s1 = stepFromPx(Math.max(x0, x1));
          if (s0 !== null && s1 !== null && s1 > s0) {
            onZoomRange([Math.floor(s0), Math.ceil(s1)]);
            return;
          }
        }
        onHoverStep(null);
      });
      canvas.addEventListener("dblclick", () => {
        onZoomRange(null);
      });
    }
    plotBox.__plotBounds = { padL, plotW, xMin, xMax, logX: state.logX };
  }

  // --- Shared Interactive Explorer Widget (used in Cards AND Side Panel) -----
  function createInteractiveExplorer(initialSpec = {}, options = {}) {
    const isSidePanel = Boolean(options.isSidePanel);
    let spec = {};
    if (typeof initialSpec === "string") {
      const trimmed = initialSpec.trim();
      try {
        spec = JSON.parse(trimmed);
      } catch {
        spec = { project: trimmed };
      }
    } else if (initialSpec && typeof initialSpec === "object") {
      spec = { ...initialSpec };
    }

    const initialRuns = Array.isArray(spec.runs) ? spec.runs : [];
    const state = {
      project: spec.project || "",
      runs: initialRuns,
      soloRun: spec.soloRun || (initialRuns.length === 1 ? initialRuns[0] : ""),
      metrics: Array.isArray(spec.metrics) ? spec.metrics : [],
      metricGroup: spec.metrics?.length ? "all" : "core",
      xAxis: spec.x_axis || spec.xAxis || "step",
      smoothing: typeof spec.smoothing === "number" ? spec.smoothing : 10,
      logX: Boolean(spec.log_x || spec.logX),
      logY: Boolean(spec.log_y || spec.logY),
      page: spec.page || "metrics",
      mode: spec.mode === "dashboard" || (spec.page && spec.page !== "metrics") ? "dashboard" : "chart",
      live: spec.live !== false,
      disabledRuns: new Set(),
      hoverStep: null,
      xRange: null,
      data: null,
      loading: true,
      error: null,
    };

    const root = document.createElement("div");
    root.className = isSidePanel ? "pi-trackio-dock-inner" : "pi-trackio-card";
    if (isSidePanel) {
      root.style.cssText = "display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden";
    }

    const header = document.createElement("div");
    header.className = "pi-trackio-header";

    const brand = document.createElement("div");
    brand.className = "pi-trackio-brand";
    const dotSpan = document.createElement("span");
    dotSpan.className = "pi-trackio-dot";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = spec.title || "Trackio";
    brand.append(dotSpan, titleSpan);

    const projectSelect = document.createElement("select");
    projectSelect.className = "pi-trackio-select";
    projectSelect.title = "Select Trackio project";
    projectSelect.onchange = () => {
      state.project = projectSelect.value;
      state.soloRun = "";
      state.runs = [];
      state.disabledRuns.clear();
      state.xRange = null;
      void fetchAndRender(true);
    };

    const runFocusSelect = document.createElement("select");
    runFocusSelect.className = "pi-trackio-select";
    runFocusSelect.title = "Inspect all runs or focus on a single run's loss & metrics";
    runFocusSelect.style.maxWidth = "210px";
    runFocusSelect.onchange = () => {
      state.soloRun = runFocusSelect.value;
      popBtn.href = buildTrackioAppUrl(state);
      void fetchAndRender(true);
      if (state.mode === "dashboard") {
        const iframe = bodyWrap.querySelector("iframe");
        if (iframe) iframe.src = buildTrackioAppUrl({ ...state, sidebar: "collapsed" });
      }
    };

    const liveBadge = document.createElement("button");
    liveBadge.type = "button";
    liveBadge.className = "pi-trackio-live" + (state.live ? "" : " is-paused");
    liveBadge.textContent = state.live ? "● Live" : "Paused";
    liveBadge.title = "Toggle live auto-refresh (4s)";
    liveBadge.onclick = () => {
      state.live = !state.live;
      liveBadge.className = "pi-trackio-live" + (state.live ? "" : " is-paused");
      liveBadge.textContent = state.live ? "● Live" : "Paused";
    };

    const spacer = document.createElement("div");
    spacer.style.flex = "1";

    const chartModeBtn = document.createElement("button");
    chartModeBtn.type = "button";
    chartModeBtn.className = "pi-trackio-btn" + (state.mode === "chart" ? " is-active" : "");
    chartModeBtn.textContent = "📈 Loss & Curves";

    const dashModeBtn = document.createElement("button");
    dashModeBtn.type = "button";
    dashModeBtn.className = "pi-trackio-btn" + (state.mode === "dashboard" ? " is-active" : "");
    dashModeBtn.textContent = "🧭 Full Trackio UI";

    const citeBtn = document.createElement("button");
    citeBtn.type = "button";
    citeBtn.className = "pi-trackio-btn";
    citeBtn.textContent = "Cite ⎘";
    citeBtn.title = "Insert current project/run/loss summary into chat composer";
    citeBtn.onclick = async () => {
      const iframe = bodyWrap.querySelector("iframe");
      if (state.mode === "dashboard" && iframe) {
        const viewState = await requestIframeViewState(iframe);
        if (viewState) {
          const runsList = (viewState.runs || []).map((r) => r.name || r.id).join(", ");
          const metricsList = (viewState.metrics_on_screen || viewState.metrics || []).slice(0, 8).join(", ");
          const rangeStr = viewState.x_range ? ` (steps ${viewState.x_range[0]}..${viewState.x_range[1]})` : "";
          insertIntoChatComposer(
            `[Trackio view: project="${viewState.project || state.project}" runs=[${runsList}] metrics=[${metricsList}]${rangeStr}]`,
          );
          citeBtn.textContent = "Cited ✓";
          setTimeout(() => {
            citeBtn.textContent = "Cite ⎘";
          }, 1400);
          return;
        }
      }
      const activeRuns = (state.data?.series || [])
        .filter((s) => (state.soloRun ? s.run === state.soloRun : !state.disabledRuns.has(s.run)))
        .map((s) => {
          const sortedKeys = Object.keys(s.latest || {}).sort((a, b) => metricPriority(a) - metricPriority(b));
          const kv = sortedKeys
            .slice(0, 4)
            .map((k) => `${k}=${formatNum(s.latest[k])}`)
            .join(", ");
          return `${s.run}${kv ? ` (${kv})` : ""}`;
        })
        .join("; ");
      const rangeStr = state.xRange ? ` steps=${state.xRange[0]}..${state.xRange[1]}` : "";
      insertIntoChatComposer(
        `[Trackio view: project="${state.project}"${state.soloRun ? ` run="${state.soloRun}"` : ""}${rangeStr} | ${activeRuns || "no active runs"}]`,
      );
      citeBtn.textContent = "Cited ✓";
      setTimeout(() => {
        citeBtn.textContent = "Cite ⎘";
      }, 1400);
    };

    const popBtn = document.createElement("a");
    popBtn.className = "pi-trackio-btn";
    popBtn.style.textDecoration = "none";
    popBtn.target = "_blank";
    popBtn.rel = "noopener noreferrer";
    popBtn.textContent = "↗";
    popBtn.title = "Open in new browser tab";
    popBtn.href = buildTrackioAppUrl(state);

    header.append(brand, projectSelect, runFocusSelect, liveBadge, spacer, chartModeBtn, dashModeBtn);

    if (!isSidePanel) {
      const dockBtn = document.createElement("button");
      dockBtn.type = "button";
      dockBtn.className = "pi-trackio-btn";
      dockBtn.textContent = "Side Panel ◫";
      dockBtn.title = "Open in split-screen side panel beside chat";
      dockBtn.onclick = () => {
        openDock({
          project: state.project,
          runs: state.runs,
          soloRun: state.soloRun,
          metrics: state.metrics,
          page: state.page,
          xAxis: state.xAxis,
          smoothing: state.smoothing,
        });
      };
      header.append(dockBtn);
    }

    header.append(citeBtn, popBtn);

    if (isSidePanel && Array.isArray(options.extraHeaderButtons)) {
      for (const b of options.extraHeaderButtons) header.append(b);
    }

    // Controls Bar (for Loss & Curves mode)
    const controls = document.createElement("div");
    controls.className = "pi-trackio-controls";

    const groupTabsWrap = document.createElement("div");
    groupTabsWrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap";
    const GROUPS = [
      ["core", "★ Loss & Core"],
      ["train", "train/*"],
      ["eval", "eval & val/*"],
      ["perf", "perf & opt/*"],
      ["all", "All Metrics"],
    ];
    const groupBtns = new Map();
    for (const [gid, glabel] of GROUPS) {
      const gb = document.createElement("button");
      gb.type = "button";
      gb.className = "pi-trackio-btn" + (state.metricGroup === gid ? " is-active" : "");
      gb.textContent = glabel;
      gb.onclick = () => {
        state.metricGroup = gid;
        for (const [k, btn] of groupBtns.entries()) {
          btn.className = "pi-trackio-btn" + (k === gid ? " is-active" : "");
        }
        rebuildPlotGrid();
        rebuildRunsAndSummary();
      };
      groupBtns.set(gid, gb);
      groupTabsWrap.append(gb);
    }

    const smoothLabel = document.createElement("label");
    smoothLabel.style.cssText = "display:inline-flex;align-items:center;gap:4px;color:var(--text-dim,#a2b2d4)";
    const smoothInput = document.createElement("input");
    smoothInput.type = "range";
    smoothInput.min = "0";
    smoothInput.max = "95";
    smoothInput.value = String(state.smoothing);
    smoothInput.style.width = "64px";
    const smoothVal = document.createElement("span");
    smoothVal.textContent = `${state.smoothing}%`;
    smoothInput.oninput = () => {
      state.smoothing = Number(smoothInput.value);
      smoothVal.textContent = `${state.smoothing}%`;
      repaintPlots();
    };
    smoothLabel.append("Smooth", smoothInput, smoothVal);

    const logYBtn = document.createElement("button");
    logYBtn.type = "button";
    logYBtn.className = "pi-trackio-btn" + (state.logY ? " is-active" : "");
    logYBtn.textContent = "Log Y";
    logYBtn.onclick = () => {
      state.logY = !state.logY;
      logYBtn.className = "pi-trackio-btn" + (state.logY ? " is-active" : "");
      repaintPlots();
    };

    const resetZoomBtn = document.createElement("button");
    resetZoomBtn.type = "button";
    resetZoomBtn.className = "pi-trackio-btn";
    resetZoomBtn.style.display = "none";
    resetZoomBtn.textContent = "Reset Zoom";
    resetZoomBtn.onclick = () => {
      state.xRange = null;
      resetZoomBtn.style.display = "none";
      repaintPlots();
    };

    const metricFilterInput = document.createElement("input");
    metricFilterInput.type = "text";
    metricFilterInput.placeholder = "Filter metrics…";
    metricFilterInput.className = "pi-trackio-select";
    metricFilterInput.style.width = "120px";
    metricFilterInput.value = state.metrics.join(",");
    metricFilterInput.oninput = () => {
      const raw = metricFilterInput.value.trim();
      state.metrics = raw
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      rebuildPlotGrid();
      rebuildRunsAndSummary();
    };

    controls.append(groupTabsWrap, smoothLabel, logYBtn, resetZoomBtn, metricFilterInput);

    // Full Trackio UI sub-navigation bar (shown when mode === "dashboard")
    const dashNav = document.createElement("div");
    dashNav.className = "pi-trackio-controls";
    dashNav.style.display = "none";
    const dashPageLabel = document.createElement("span");
    dashPageLabel.style.color = "var(--text-dim,#a2b2d4)";
    dashPageLabel.textContent = "Trackio Tab:";
    dashNav.append(dashPageLabel);
    const dashPageBtns = new Map();
    for (const [pval, plabel] of [
      ["metrics", "Metrics"],
      ["runs", "Runs Table"],
      ["system", "System / GPU"],
      ["traces", "Traces"],
      ["media", "Media"],
      ["reports", "Reports"],
      ["artifacts", "Artifacts"],
    ]) {
      const pb = document.createElement("button");
      pb.type = "button";
      pb.className = "pi-trackio-btn" + (state.page === pval ? " is-active" : "");
      pb.textContent = plabel;
      pb.onclick = () => {
        state.page = pval;
        for (const [k, b] of dashPageBtns.entries()) {
          b.className = "pi-trackio-btn" + (k === pval ? " is-active" : "");
        }
        const iframe = bodyWrap.querySelector("iframe");
        if (iframe) iframe.src = buildTrackioAppUrl({ ...state, sidebar: "collapsed" });
      };
      dashPageBtns.set(pval, pb);
      dashNav.append(pb);
    }

    const runsBar = document.createElement("div");
    runsBar.className = "pi-trackio-runs-bar";

    const scrollArea = document.createElement("div");
    if (isSidePanel) {
      scrollArea.className = "pi-trackio-dock-scroll";
    }

    const bodyWrap = document.createElement("div");
    if (isSidePanel) bodyWrap.style.flex = "1";

    const summaryWrap = document.createElement("div");
    summaryWrap.className = "pi-trackio-summary-wrap";

    scrollArea.append(bodyWrap, summaryWrap);
    root.append(header, controls, dashNav, runsBar, scrollArea);

    function visibleMetricsList() {
      let avail = [...(state.data?.availableMetrics || [])];
      if (state.soloRun) {
        const soloSeries = (state.data?.series || []).find((s) => s.run === state.soloRun);
        if (soloSeries?.metrics) {
          avail = avail.filter((m) => Array.isArray(soloSeries.metrics[m]) && soloSeries.metrics[m].length > 0);
        }
      }
      avail.sort((a, b) => {
        const pa = metricPriority(a);
        const pb = metricPriority(b);
        return pa !== pb ? pa - pb : a.localeCompare(b);
      });

      if (state.metrics && state.metrics.length > 0) {
        const matched = avail.filter((m) => state.metrics.some((pat) => safeMatchMetric(m, pat)));
        if (matched.length > 0) return matched;
      }

      if (state.metricGroup === "core") {
        const core = avail.filter(isCoreMetric);
        return core.length > 0 ? core : avail.slice(0, 12);
      }
      if (state.metricGroup === "train") {
        const tr = avail.filter((m) => m.startsWith("train/") || m === "loss" || m === "ce");
        return tr.length > 0 ? tr : avail;
      }
      if (state.metricGroup === "eval") {
        const ev = avail.filter((m) => m.startsWith("eval/") || m.startsWith("val/") || m.startsWith("ar16/"));
        return ev.length > 0 ? ev : avail;
      }
      if (state.metricGroup === "perf") {
        const pf = avail.filter(
          (m) => m.startsWith("perf/") || m.startsWith("opt/") || m.startsWith("ffn_opt/") || m.startsWith("act_comp/"),
        );
        return pf.length > 0 ? pf : avail;
      }
      return avail;
    }

    function setMode(mode) {
      state.mode = mode;
      chartModeBtn.className = "pi-trackio-btn" + (mode === "chart" ? " is-active" : "");
      dashModeBtn.className = "pi-trackio-btn" + (mode === "dashboard" ? " is-active" : "");
      controls.style.display = mode === "chart" ? "flex" : "none";
      dashNav.style.display = mode === "dashboard" ? "flex" : "none";
      runsBar.style.display = mode === "chart" ? "flex" : "none";
      summaryWrap.style.display = mode === "chart" ? "block" : "none";
      popBtn.href = buildTrackioAppUrl(state);
      if (mode === "dashboard") {
        bodyWrap.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "pi-trackio-iframe-wrap";
        if (isSidePanel) wrap.style.height = "calc(100vh - 88px)";
        const iframe = document.createElement("iframe");
        iframe.src = buildTrackioAppUrl({ ...state, sidebar: "collapsed" });
        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
        iframe.allow = "clipboard-write";
        wrap.append(iframe);
        bodyWrap.append(wrap);
      } else {
        rebuildPlotGrid();
      }
    }

    chartModeBtn.onclick = () => setMode("chart");
    dashModeBtn.onclick = () => setMode("dashboard");

    function repaintPlots() {
      const boxes = bodyWrap.querySelectorAll(".pi-trackio-plot-box");
      for (const box of boxes) {
        const m = box.dataset.metric;
        if (m) {
          renderMetricPlot(
            box,
            m,
            state,
            (step) => {
              state.hoverStep = step;
              for (const b of bodyWrap.querySelectorAll(".pi-trackio-plot-box")) {
                if (b.dataset.metric) renderMetricPlot(b, b.dataset.metric, state, () => {}, () => {});
              }
            },
            (range) => {
              state.xRange = range;
              resetZoomBtn.style.display = range ? "inline-flex" : "none";
              repaintPlots();
            },
          );
        }
      }
    }

    function rebuildPlotGrid() {
      if (state.mode !== "chart") return;
      bodyWrap.innerHTML = "";
      if (state.loading && !state.data) {
        const msg = document.createElement("div");
        msg.style.cssText = "padding:18px;color:var(--text-dim,#a2b2d4);font-size:12px";
        msg.textContent = "Loading Trackio per-run loss & metrics…";
        bodyWrap.append(msg);
        return;
      }
      if (state.error) {
        const errDiv = document.createElement("div");
        errDiv.style.cssText = "padding:14px;color:#fda4af;font-size:12px";
        errDiv.textContent = String(state.error);
        bodyWrap.append(errDiv);
        return;
      }
      const metricsToShow = visibleMetricsList();
      if (metricsToShow.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.style.cssText = "padding:16px;color:var(--text-dim,#a2b2d4);font-size:12px";
        emptyDiv.textContent = `No scalar metrics matched in project "${state.project || "(none)"}". Click "All Metrics" or "🧭 Full Trackio UI".`;
        bodyWrap.append(emptyDiv);
        return;
      }
      const grid = document.createElement("div");
      grid.className = "pi-trackio-grid";
      for (const m of metricsToShow.slice(0, 16)) {
        const box = document.createElement("div");
        box.className = "pi-trackio-plot-box";
        box.dataset.metric = m;
        const titleRow = document.createElement("div");
        titleRow.className = "pi-trackio-plot-title";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = m;
        const subSpan = document.createElement("span");
        subSpan.className = "pi-trackio-plot-sub";
        titleRow.append(nameSpan, subSpan);

        const canvasWrap = document.createElement("div");
        canvasWrap.className = "pi-trackio-canvas-wrap";
        const canvas = document.createElement("canvas");
        const tooltip = document.createElement("div");
        tooltip.className = "pi-trackio-tooltip";
        canvasWrap.append(canvas, tooltip);

        box.append(titleRow, canvasWrap);
        grid.append(box);
      }
      bodyWrap.append(grid);
      requestAnimationFrame(() => repaintPlots());
    }

    function rebuildRunsAndSummary() {
      const data = state.data;
      if (!data) return;

      if (Array.isArray(data.allProjects) && data.allProjects.length > 0) {
        projectSelect.innerHTML = "";
        for (const p of data.allProjects) {
          const opt = document.createElement("option");
          opt.value = p;
          opt.textContent = p;
          if (p === data.project) opt.selected = true;
          projectSelect.append(opt);
        }
      }

      const series = data.series || [];
      const allRunNames = Array.isArray(state.allProjectRuns) && state.allProjectRuns.length > 0
        ? state.allProjectRuns
        : series.map((s) => s.run);
      runFocusSelect.innerHTML = "";
      const allOpt = document.createElement("option");
      allOpt.value = "";
      allOpt.textContent = `All Runs (${allRunNames.length})`;
      if (!state.soloRun) allOpt.selected = true;
      runFocusSelect.append(allOpt);
      for (const rName of allRunNames) {
        const opt = document.createElement("option");
        opt.value = rName;
        opt.textContent = `🎯 ${rName}`;
        if (rName === state.soloRun) opt.selected = true;
        runFocusSelect.append(opt);
      }

      runsBar.innerHTML = "";
      const runsTitle = document.createElement("span");
      runsTitle.style.cssText = "color:var(--text-dim,#a2b2d4);font-weight:600";
      runsTitle.textContent = state.soloRun ? "Focused Run (click to show all):" : "Runs (click=toggle, dblclick=solo):";
      runsBar.append(runsTitle);

      if (series.length === 0) {
        const noneSpan = document.createElement("span");
        noneSpan.style.color = "var(--text-dim,#a2b2d4)";
        noneSpan.textContent = "none";
        runsBar.append(noneSpan);
      } else {
        for (const s of series) {
          const chip = document.createElement("button");
          chip.type = "button";
          const isSolo = state.soloRun === s.run;
          const isOff = state.soloRun ? !isSolo : state.disabledRuns.has(s.run);
          chip.className = "pi-trackio-run-chip" + (isSolo ? " is-solo" : "") + (isOff ? " is-off" : "");
          const color = PALETTE[s.colorIndex % PALETTE.length];
          const swatch = document.createElement("span");
          swatch.className = "pi-trackio-swatch";
          swatch.style.background = color;
          const runLabel = document.createElement("span");
          runLabel.textContent = s.run;
          chip.append(swatch, runLabel);
          chip.onclick = () => {
            if (state.soloRun) {
              state.soloRun = state.soloRun === s.run ? "" : s.run;
              runFocusSelect.value = state.soloRun;
              rebuildRunsAndSummary();
              rebuildPlotGrid();
              return;
            }
            if (state.disabledRuns.has(s.run)) state.disabledRuns.delete(s.run);
            else state.disabledRuns.add(s.run);
            chip.className = "pi-trackio-run-chip" + (state.disabledRuns.has(s.run) ? " is-off" : "");
            repaintPlots();
          };
          chip.ondblclick = (e) => {
            e.preventDefault();
            state.soloRun = state.soloRun === s.run ? "" : s.run;
            runFocusSelect.value = state.soloRun;
            rebuildRunsAndSummary();
            rebuildPlotGrid();
          };
          runsBar.append(chip);
        }
      }

      // Per-Run Loss & Metrics Summary Table
      const metricsToShow = visibleMetricsList();
      if (state.soloRun) {
        const solo = series.find((s) => s.run === state.soloRun);
        if (solo) {
          const rowsHtml = metricsToShow
            .map((m) => {
              const pts = solo.metrics?.[m] || [];
              if (!pts.length) return "";
              const first = pts[0].value;
              const latest = solo.latest?.[m];
              const min = solo.min?.[m];
              const max = solo.max?.[m];
              const delta = latest !== undefined && first !== undefined ? latest - first : null;
              const deltaHtml =
                delta !== null && pts.length > 1
                  ? `<span style="color:${delta <= 0 ? "#4ade80" : "#fb923c"}">${delta >= 0 ? "+" : ""}${escHtml(formatNum(delta))}</span>`
                  : "—";
              return (
                `<tr>` +
                `<td><b>${escHtml(m)}</b></td>` +
                `<td>${escHtml(formatNum(first))}</td>` +
                `<td><b>${escHtml(formatNum(latest))}</b></td>` +
                `<td>${deltaHtml}</td>` +
                `<td>${escHtml(formatNum(min))}</td>` +
                `<td>${escHtml(formatNum(max))}</td>` +
                `<td>${pts.length} (s${pts[0].step}..${pts[pts.length - 1].step})</td>` +
                `</tr>`
              );
            })
            .filter(Boolean)
            .join("");
          summaryWrap.innerHTML =
            `<div style="margin-bottom:5px;color:var(--text-dim,#a2b2d4);font-weight:600">Per-Run Breakdown: <span style="color:#fff">${escHtml(solo.run)}</span></div>` +
            `<table class="pi-trackio-table"><thead><tr><th>Metric</th><th>Start</th><th>Latest</th><th>Δ</th><th>Min</th><th>Max</th><th>Steps</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
          return;
        }
      }

      const tableMetrics = metricsToShow.slice(0, 8);
      if (series.length > 0 && tableMetrics.length > 0) {
        const rowsHtml = series
          .filter((s) => !state.disabledRuns.has(s.run))
          .map((s) => {
            const color = PALETTE[s.colorIndex % PALETTE.length];
            const cells = tableMetrics
              .map((m) => {
                const pts = s.metrics?.[m] || [];
                const latest = s.latest?.[m];
                const min = s.min?.[m];
                const max = s.max?.[m];
                if (latest === undefined) return `<td>—</td>`;
                const first = pts[0]?.value;
                const delta =
                  first !== undefined && pts.length > 1
                    ? ` <span style="color:${latest - first <= 0 ? "#4ade80" : "#fb923c"};font-size:10px">(${latest - first >= 0 ? "+" : ""}${escHtml(formatNum(latest - first))})</span>`
                    : "";
                return `<td><b>${escHtml(formatNum(latest))}</b>${delta} <span style="color:var(--text-dim,#94a3b8);font-size:10px">[${escHtml(formatNum(min))}..${escHtml(formatNum(max))}]</span></td>`;
              })
              .join("");
            return (
              `<tr>` +
              `<td style="cursor:pointer" data-solo-run="${escHtml(s.run)}" title="Click to focus on this run"><span class="pi-trackio-swatch" style="background:${escHtml(color)};display:inline-block;margin-right:6px"></span><b>${escHtml(s.run)}</b></td>` +
              `${cells}</tr>`
            );
          })
          .join("");
        summaryWrap.innerHTML =
          `<table class="pi-trackio-table"><thead><tr><th>Run (click to focus)</th>` +
          tableMetrics.map((m) => `<th>${escHtml(m)}</th>`).join("") +
          `</tr></thead><tbody>${rowsHtml}</tbody></table>`;
        for (const cell of summaryWrap.querySelectorAll("td[data-solo-run]")) {
          cell.addEventListener("click", () => {
            state.soloRun = cell.getAttribute("data-solo-run") || "";
            runFocusSelect.value = state.soloRun;
            rebuildRunsAndSummary();
            rebuildPlotGrid();
          });
        }
      } else {
        summaryWrap.innerHTML = "";
      }
    }

    async function fetchAndRender(forceRebuild = false) {
      try {
        const runsToRequest = state.soloRun
          ? [state.soloRun]
          : state.runs.length > 0
            ? state.runs
            : undefined;
        const payload = await fetchSeriesDirect({
          project: state.project || undefined,
          runs: runsToRequest,
          xAxis: state.xAxis,
        });
        state.allProjectRuns = payload.allRuns;
        const prevMetricsKey = (state.data?.availableMetrics || []).join("|");
        const nextMetricsKey = (payload.availableMetrics || []).join("|");
        state.data = payload;
        if (!state.project && payload.project) state.project = payload.project;
        state.loading = false;
        state.error = null;
        popBtn.href = buildTrackioAppUrl(state);
        rebuildRunsAndSummary();
        if (state.mode === "chart") {
          if (forceRebuild || prevMetricsKey !== nextMetricsKey || !bodyWrap.querySelector(".pi-trackio-grid")) {
            rebuildPlotGrid();
          } else {
            repaintPlots();
          }
        }
      } catch (err) {
        state.loading = false;
        if (!state.data) {
          state.error = `Trackio series fetch failed: ${err?.message || err}`;
          if (state.mode === "chart") rebuildPlotGrid();
        }
      }
    }

    function updateSpec(newSpec = {}) {
      if (newSpec.project !== undefined && newSpec.project !== state.project) {
        state.project = newSpec.project;
        state.disabledRuns.clear();
      }
      if (Array.isArray(newSpec.runs)) {
        state.runs = newSpec.runs;
        state.soloRun = newSpec.soloRun ?? (newSpec.runs.length === 1 ? newSpec.runs[0] : "");
      } else if (newSpec.soloRun !== undefined) {
        state.soloRun = newSpec.soloRun;
      }
      if (Array.isArray(newSpec.metrics)) {
        state.metrics = newSpec.metrics;
        metricFilterInput.value = state.metrics.join(",");
      }
      if (newSpec.page && newSpec.page !== "metrics") {
        state.page = newSpec.page;
        setMode("dashboard");
      } else if (newSpec.mode) {
        setMode(newSpec.mode);
      } else {
        setMode("chart");
      }
      void fetchAndRender(true);
    }

    setMode(state.mode);
    void fetchAndRender(true);

    const pollInterval = setInterval(() => {
      if (!document.body.contains(root)) {
        clearInterval(pollInterval);
        return;
      }
      if (!state.live || document.hidden || state.mode !== "chart") return;
      void fetchAndRender(false);
    }, 4000);

    const resizeObserver = new ResizeObserver(() => {
      if (state.mode === "chart") repaintPlots();
    });
    resizeObserver.observe(root);

    return { root, updateSpec, state };
  }

  function mountInlineCard(hostNode, rawSpec) {
    let spec = {};
    if (typeof rawSpec === "string") {
      try {
        spec = JSON.parse(rawSpec.trim());
      } catch {
        spec = { project: rawSpec.trim() };
      }
    } else if (rawSpec && typeof rawSpec === "object") {
      spec = { ...rawSpec };
    }
    const explorer = createInteractiveExplorer(spec, { isSidePanel: false });
    hostNode.replaceWith(explorer.root);
    if (spec.open_side_panel || spec.openSidePanel) {
      openDock(spec);
    }
  }

  // --- Split-Screen Right-Hand Side Panel (#pi-trackio-dock) -----------------
  let dockEl = null;
  let dockExplorer = null;

  function findSplitScreenHost() {
    const filePanel = document.getElementById("file-panel");
    if (filePanel && filePanel.parentElement) {
      return { parent: filePanel.parentElement, before: filePanel };
    }
    return { parent: document.body, before: null };
  }

  function openDock(spec = {}) {
    if (!dockEl || !document.body.contains(dockEl)) {
      dockEl = document.createElement("aside");
      dockEl.id = DOCK_ID;
      dockEl.setAttribute("aria-label", "Trackio split-screen dashboard");

      const resizeGrip = document.createElement("div");
      resizeGrip.className = "pi-trackio-dock-resize";
      resizeGrip.title = "Drag to resize split-screen panel";
      let dragging = false;
      resizeGrip.addEventListener("pointerdown", (e) => {
        dragging = true;
        resizeGrip.classList.add("is-dragging");
        e.preventDefault();
      });
      window.addEventListener("pointermove", (e) => {
        if (!dragging || !dockEl) return;
        const w = Math.max(340, Math.min(window.innerWidth * 0.84, window.innerWidth - e.clientX));
        dockEl.classList.remove("is-maximized");
        dockEl.style.setProperty("--trackio-dock-width", `${Math.round(w)}px`);
      });
      window.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        resizeGrip.classList.remove("is-dragging");
      });

      const backupBtn = document.createElement("button");
      backupBtn.type = "button";
      backupBtn.className = "pi-trackio-btn";
      backupBtn.textContent = "☁ GCS";
      backupBtn.title = "Run online SQLite snapshot + sync to GCS bucket now";
      backupBtn.onclick = async () => {
        backupBtn.disabled = true;
        backupBtn.textContent = "Sync…";
        try {
          const r = await fetch("/__trackio/backup", {
            method: "POST",
            headers: { "content-type": "application/json", "x-pi-trackio": "1" },
            body: "{}",
          });
          const d = await r.json();
          backupBtn.textContent = d.ok ? "Synced ✓" : "Err";
        } catch {
          backupBtn.textContent = "Err";
        }
        setTimeout(() => {
          backupBtn.disabled = false;
          backupBtn.textContent = "☁ GCS";
        }, 2000);
      };

      const maxBtn = document.createElement("button");
      maxBtn.type = "button";
      maxBtn.className = "pi-trackio-btn";
      maxBtn.textContent = "⤢";
      maxBtn.title = "Toggle wide split-screen";
      maxBtn.onclick = () => dockEl.classList.toggle("is-maximized");

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "pi-trackio-btn";
      closeBtn.textContent = "✕";
      closeBtn.title = "Close Trackio side panel";
      closeBtn.onclick = () => {
        dockEl.remove();
        dockEl = null;
        dockExplorer = null;
        const toolbarBtn = document.getElementById(TOOLBAR_ID);
        toolbarBtn?.setAttribute("aria-expanded", "false");
      };

      dockExplorer = createInteractiveExplorer(spec, {
        isSidePanel: true,
        extraHeaderButtons: [backupBtn, maxBtn, closeBtn],
      });

      dockEl.append(resizeGrip, dockExplorer.root);

      const { parent, before } = findSplitScreenHost();
      if (before) parent.insertBefore(dockEl, before);
      else parent.append(dockEl);
    } else if (dockExplorer) {
      dockExplorer.updateSpec(spec);
    }

    const toolbarBtn = document.getElementById(TOOLBAR_ID);
    toolbarBtn?.setAttribute("aria-expanded", "true");
  }

  function toggleDock() {
    if (dockEl && document.body.contains(dockEl)) {
      dockEl.remove();
      dockEl = null;
      dockExplorer = null;
      const toolbarBtn = document.getElementById(TOOLBAR_ID);
      toolbarBtn?.setAttribute("aria-expanded", "false");
    } else {
      openDock({});
    }
  }

  window.__piTrackioOpenDock = openDock;

  // --- Scan DOM for toolbar, ```trackio blocks, and Trackio links ------------
  function scanDom() {
    if (dockEl && document.body.contains(dockEl)) {
      const { parent, before } = findSplitScreenHost();
      if (dockEl.parentElement !== parent) {
        if (before) parent.insertBefore(dockEl, before);
        else parent.append(dockEl);
      }
    }

    const existingBtn = document.getElementById(TOOLBAR_ID);
    if (!existingBtn) {
      const anchor =
        document.getElementById("pi-web-tmux-toolbar") ||
        document.querySelector('button[aria-controls="file-panel"]');
      if (anchor?.parentElement) {
        const btn = document.createElement("button");
        btn.id = TOOLBAR_ID;
        btn.dataset.version = VERSION;
        btn.type = "button";
        btn.title = "Toggle Trackio split-screen experiment dashboard";
        btn.setAttribute("aria-controls", DOCK_ID);
        btn.setAttribute("aria-expanded", String(Boolean(dockEl && document.body.contains(dockEl))));
        const dot = document.createElement("span");
        dot.className = "pi-trackio-dot";
        dot.style.marginRight = "6px";
        btn.append(dot, document.createTextNode("Trackio"));
        btn.style.cssText =
          "display:inline-flex;align-items:center;min-height:44px;padding:0 10px;border:none;background:transparent;color:var(--text-dim,#a2b2d4);font:inherit;font-size:12px;cursor:pointer;flex-shrink:0";
        btn.onclick = () => toggleDock();
        anchor.parentElement.insertBefore(btn, anchor);
      }
    }

    const codeBlocks = document.querySelectorAll(".markdown-code-block");
    for (const block of codeBlocks) {
      if (block.dataset.trackioMounted) continue;
      const langNode = block.querySelector(".markdown-code-lang");
      const lang = (langNode?.textContent || "").trim().toLowerCase();
      if (lang !== "trackio") continue;
      const codeNode = block.querySelector("pre code, pre");
      const rawText = (codeNode?.textContent || "").trim();
      if (!rawText) continue;
      let parsedSpec = null;
      if (rawText.startsWith("{") && rawText.endsWith("}")) {
        try {
          parsedSpec = JSON.parse(rawText);
        } catch {
          parsedSpec = null;
        }
      } else if (/^[A-Za-z0-9_.-]{1,80}$/.test(rawText)) {
        parsedSpec = { project: rawText };
      }
      if (!parsedSpec || typeof parsedSpec !== "object") continue;
      block.dataset.trackioMounted = "1";
      mountInlineCard(block, parsedSpec);
    }

    const links = document.querySelectorAll(
      '.markdown-body a[href*="/__trackio"], .markdown-body a[href*="127.0.0.1:30143"], .markdown-body a[href*="localhost:30143"], .markdown-body a[href^="trackio://"]',
    );
    for (const link of links) {
      if (
        link.dataset.trackioEnhanced ||
        link.classList.contains("pi-trackio-btn") ||
        link.classList.contains("pi-trackio-ext-tab")
      ) {
        continue;
      }
      const parsed = parseTrackioLinkHref(link.getAttribute("href") || "");
      if (!parsed) continue;
      link.dataset.trackioEnhanced = "1";
      link.classList.add("pi-trackio-dashboard-link");
      const sameOriginUrl = buildTrackioAppUrl(parsed);
      link.setAttribute("href", sameOriginUrl);
      link.title = "Click to open in Trackio split-screen side panel";

      link.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        openDock(parsed);
      });

      const extTab = document.createElement("a");
      extTab.className = "pi-trackio-ext-tab";
      extTab.href = sameOriginUrl;
      extTab.target = "_blank";
      extTab.rel = "noopener noreferrer";
      extTab.textContent = "↗";
      extTab.title = "Open in new browser tab";
      link.insertAdjacentElement("afterend", extTab);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanDom, { once: true });
  } else {
    scanDom();
  }
  new MutationObserver(scanDom).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
