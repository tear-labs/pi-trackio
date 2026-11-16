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

  const VERSION = "trackio-v11";
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
  const COMPUTE_DOCK_ID = "pi-compute-dock";
  const COMPUTE_TOOLBAR_ID = "pi-web-compute-toolbar";
  const COMPUTE_URL = "/__trackio/compute";

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
    .markdown-code-block.pi-trackio-upgraded {
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
      padding: 0 !important;
    }
    .markdown-code-block.pi-trackio-upgraded > .markdown-code-header,
    .markdown-code-block.pi-trackio-upgraded > pre,
    .markdown-code-block.pi-trackio-upgraded > div:not(.pi-trackio-card) {
      display: none !important;
    }
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
      flex-wrap: wrap;
      overflow-wrap: anywhere;
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
  style.textContent += `
    #pi-compute-dock {
      position:relative; display:flex; flex-direction:column;
      flex:0 0 var(--pi-compute-width, clamp(420px, 46vw, 780px));
      min-width:360px; height:100%; min-height:0; background:#0a1020;
      border-left:1px solid rgba(125,211,252,.18); overflow:hidden;
      color:var(--text,#f1f5ff); font-family:system-ui,-apple-system,sans-serif;
    }
    .pi-compute-grip {
      position:absolute; left:0; top:0; bottom:0; width:6px;
      cursor:col-resize; z-index:10;
    }
    .pi-compute-grip:hover, .pi-compute-grip.is-dragging {
      background:rgba(56,189,248,.18);
    }
    .pi-compute-header {
      display:flex; align-items:center; gap:6px; padding:0 10px;
      height:40px; flex:0 0 40px; box-sizing:border-box;
      border-bottom:1px solid var(--border,rgba(150,190,255,.14));
      background:rgba(255,255,255,.03); font-size:12px;
      color:var(--text-dim,#a2b2d4);
    }
    .pi-compute-header strong { font-size:13px; color:var(--text,#f1f5ff); }
    .pi-compute-body { display:flex; flex:1; min-height:0; }
    .pi-compute-dock iframe{flex:1;min-height:0}
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
    } else {
      // A project can contain thousands of metrics. Mounting all their Svelte
      // chart panels freezes the shared pi-web thread before Vega's viewport
      // guard runs. Start with an overview; the dashboard pager exposes the rest.
      const overview = spec.data?.availableMetrics?.slice(0, 12);
      if (overview?.length) params.set("metrics", overview.join(","));
      else params.set("metric_filter", "^(loss|ce|train/(loss|ce|grad_norm|lr)|eval/(loss|heldout_ce))$");
    }
    if (spec.xAxis && spec.xAxis !== "step") params.set("x_axis", spec.xAxis);
    if (spec.smoothing != null) params.set("smoothing", String(spec.smoothing));
    if (spec.sidebar) params.set("sidebar", spec.sidebar);
    if (spec.navbar) params.set("navbar", spec.navbar);
    params.set("__theme", currentThemeParam());
    const qs = params.toString();
    return `/__trackio/app${pagePath}${qs ? `?${qs}` : ""}`;
  }

  function isComputeHref(href) {
    if (!href) return false;
    try {
      return new URL(href, window.location.href).pathname === COMPUTE_URL;
    } catch {
      return String(href).startsWith(COMPUTE_URL);
    }
  }

  function parseTrackioLinkHref(rawHref) {
    if (!rawHref) return null;
    try {
      if (rawHref.startsWith("trackio://") || rawHref.startsWith("https://trackio.local") || rawHref.startsWith("http://trackio.local")) {
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
      all: Boolean(params.allRuns),
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
          : params.allRuns ? allRuns : allRuns.slice(0, 12);
      const selectedRuns = wantedRuns.length > 0 ? wantedRuns : allRuns.slice(0, 12);

      const batch =
        selectedRuns.length > 0
          ? await callTrackioApi("get_logs_batch", {
              project,
              runs: selectedRuns.map((r) => ({ run: r, run_id: null })),
              max_points: Math.max(1, Math.min(220, Math.floor(4000 / selectedRuns.length))),
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
  function matchesJobFilter(state, run) {
    if (!state.jobFilter || state.jobFilter === "all") return true;
    const records = (state.activity?.runs || []).filter(r => r.run_name === run);
    const status = records.length === 1 ? records[0].job?.status || "unknown" : "unknown";
    if (state.jobFilter === "running") return status === "running";
    if (state.jobFilter === "finished") return ["completed", "failed", "cancelled", "stopped"].includes(status);
    return ["unknown", "checking"].includes(status);
  }

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
      if (!matchesJobFilter(state, s.run)) return false;
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
      allRuns: Boolean(spec.allRuns),
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
      dashboardOffset: 0,
      dashboardFilter: "",
      activity: null,
      jobFilter: "all",
    };

    const root = document.createElement("div");
    root.className = isSidePanel ? "pi-trackio-dock-inner" : "pi-trackio-card";
    if (isSidePanel) {
      root.style.cssText = "display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden";
    }
    if (window.__piTrackioStandalone) state.metricGroup = "all";

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
      state.dashboardOffset = 0;
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
        refreshDashboard();
      }
    };

    const liveBadge = document.createElement("button");
    liveBadge.type = "button";
    liveBadge.className = "pi-trackio-live" + (state.live ? "" : " is-paused");
    liveBadge.textContent = state.live ? "Auto-refresh on" : "Auto-refresh off";
    liveBadge.title = "Refresh chart data every 4s; this does not indicate whether a run is running";
    liveBadge.onclick = () => {
      state.live = !state.live;
      liveBadge.className = "pi-trackio-live" + (state.live ? "" : " is-paused");
      liveBadge.textContent = state.live ? "Auto-refresh on" : "Auto-refresh off";
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
        refreshDashboard();
      };
      dashPageBtns.set(pval, pb);
      dashNav.append(pb);
    }

    const dashboardMetrics = document.createElement("div");
    dashboardMetrics.className = "pi-trackio-controls";
    const dashboardSearch = document.createElement("input");
    dashboardSearch.className = "pi-trackio-filter";
    dashboardSearch.placeholder = "Find metrics (text or regex)";
    dashboardSearch.setAttribute("aria-label", "Find dashboard metrics");
    const dashboardCount = document.createElement("span");
    const dashboardPrev = document.createElement("button");
    const dashboardNext = document.createElement("button");
    for (const [button, label, direction] of [[dashboardPrev, "Previous charts", -1], [dashboardNext, "Next charts", 1]]) {
      button.type = "button";
      button.className = "pi-trackio-btn";
      button.textContent = label;
      button.onclick = () => {
        state.dashboardOffset = Math.max(0, state.dashboardOffset + direction * 12);
        refreshDashboard();
      };
    }
    dashboardSearch.onchange = () => {
      state.dashboardFilter = dashboardSearch.value.trim();
      state.dashboardOffset = 0;
      refreshDashboard();
    };
    dashboardMetrics.append(dashboardSearch, dashboardPrev, dashboardNext, dashboardCount);

    const allChartsLink = document.createElement("a");
    allChartsLink.className = "pi-trackio-btn";
    allChartsLink.textContent = "All charts · Run activity";
    allChartsLink.target = "_blank";
    allChartsLink.rel = "noopener";
    header.append(allChartsLink);
    const activitySummary = document.createElement("div");
    activitySummary.style.cssText = "padding:6px 10px;font-size:11px;color:var(--text-dim,#a2b2d4)";
    activitySummary.title = "Job state comes from the worker record or compute provider. Check each badge for its source and check time. Metric timestamps are separate.";
    const jobFilterSelect = document.createElement("select");
    jobFilterSelect.className = "pi-trackio-select";
    jobFilterSelect.setAttribute("aria-label", "Filter runs by job status");
    for (const [value, label] of [["all", "All job states"], ["running", "Running only"], ["finished", "Finished / stopped"], ["unknown", "Unknown / checking"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      jobFilterSelect.append(option);
    }
    jobFilterSelect.onchange = () => {
      state.jobFilter = jobFilterSelect.value;
      state.soloRun = "";
      rebuildRunsAndSummary();
      if (state.mode === "chart") rebuildPlotGrid();
    };
    header.append(jobFilterSelect);

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
    root.append(header, controls, dashNav, dashboardMetrics, activitySummary, runsBar, scrollArea);

    const visiblePlots = new Set();
    const plotObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const box = entry.target;
        const wrap = box.querySelector(".pi-trackio-canvas-wrap");
        if (entry.isIntersecting) {
          visiblePlots.add(box);
          if (!wrap.querySelector("canvas")) {
            const tooltip = document.createElement("div");
            tooltip.className = "pi-trackio-tooltip";
            wrap.append(document.createElement("canvas"), tooltip);
          }
          repaintPlot(box);
        } else {
          visiblePlots.delete(box);
          wrap.replaceChildren();
        }
      }
    }, { root: isSidePanel ? scrollArea : null, rootMargin: "400px 0px" });

    function refreshDashboard() {
      if (state.mode !== "dashboard") return;
      let metrics = state.metrics.length ? state.metrics : (state.data?.availableMetrics || []);
      if (state.dashboardFilter) metrics = metrics.filter(m => safeMatchMetric(m, state.dashboardFilter));
      if (state.dashboardOffset >= metrics.length) state.dashboardOffset = 0;
      const page = metrics.slice(state.dashboardOffset, state.dashboardOffset + 12);
      dashboardCount.textContent = metrics.length ? `${state.dashboardOffset + 1}–${state.dashboardOffset + page.length} of ${metrics.length} charts` : "No matching metrics";
      dashboardPrev.disabled = state.dashboardOffset === 0;
      dashboardNext.disabled = state.dashboardOffset + 12 >= metrics.length;
      dashboardMetrics.style.display = state.page === "metrics" ? "flex" : "none";
      const iframe = bodyWrap.querySelector("iframe");
      if (!iframe) return;
      const url = buildTrackioAppUrl({ ...state, metrics: page, metricFilter: page.length ? undefined : "(?!)", sidebar: "collapsed" });
      if (iframe.getAttribute("src") !== url) iframe.src = url;
    }

    function visibleMetricsList() {
      let avail = [...(state.data?.availableMetrics || [])];
      if (state.jobFilter !== "all") {
        const shown = (state.data?.series || []).filter(s => matchesJobFilter(state, s.run));
        avail = avail.filter(m => shown.some(s => s.metrics?.[m]?.length));
      }
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
        return matched;
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
      dashboardMetrics.style.display = mode === "dashboard" && state.page === "metrics" ? "flex" : "none";
      runsBar.style.display = mode === "chart" ? "flex" : "none";
      summaryWrap.style.display = mode === "chart" ? "block" : "none";
      liveBadge.style.display = mode === "chart" ? "inline-flex" : "none";
      jobFilterSelect.style.display = mode === "chart" ? "inline-flex" : "none";
      popBtn.href = buildTrackioAppUrl(state);
      if (mode === "dashboard") {
        plotObserver.disconnect();
        visiblePlots.clear();
        bodyWrap.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "pi-trackio-iframe-wrap";
        if (isSidePanel) wrap.style.height = "calc(100vh - 88px)";
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
        iframe.allow = "clipboard-write";
        wrap.append(iframe);
        bodyWrap.append(wrap);
        refreshDashboard();
      } else {
        rebuildPlotGrid();
      }
    }

    chartModeBtn.onclick = () => setMode("chart");
    dashModeBtn.onclick = () => setMode("dashboard");

    function repaintPlot(box) {
        const m = box.dataset.metric;
        if (m) {
          renderMetricPlot(
            box,
            m,
            state,
            (step) => {
              state.hoverStep = step;
              for (const b of visiblePlots) {
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

    function repaintPlots() {
      for (const box of visiblePlots) repaintPlot(box);
    }

    function rebuildPlotGrid() {
      if (state.mode !== "chart") return;
      plotObserver.disconnect();
      visiblePlots.clear();
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
      for (const m of metricsToShow) {
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

        box.append(titleRow, canvasWrap);
        grid.append(box);
      }
      bodyWrap.append(grid);
      for (const box of grid.children) plotObserver.observe(box);
    }

    function rebuildRunsAndSummary() {
      const data = state.data;
      if (!data) return;
      const chartParams = new URLSearchParams({ project: state.project, smoothing: String(state.smoothing) });
      allChartsLink.href = `/__trackio/charts?${chartParams}`;
      if (window.__piTrackioStandalone) {
        allChartsLink.textContent = "Full Trackio UI";
        allChartsLink.href = buildTrackioAppUrl(state);
      }
      const activityByName = new Map();
      for (const row of state.activity?.runs || []) {
        activityByName.set(row.run_name, activityByName.has(row.run_name)
          ? { ...row, job: { status: "unknown", detail: "Multiple run identities share this name." } }
          : row);
      }
      const activityLabel = (r) => {
        if (!r) return "Unknown";
        const metricAge = r.metricAgeSeconds;
        const age = metricAge === null ? "no metrics yet" : metricAge < 60 ? `${Math.floor(metricAge)}s ago` : metricAge < 3600 ? `${Math.floor(metricAge / 60)}m ago` : `${Math.floor(metricAge / 3600)}h ago`;
        const job = r.job?.label || "Unknown";
        const reported = r.job?.source === "Trackio config (reported)" ? " (reported)" : "";
        return `${job}${reported} · metrics ${age}`;
      };
      if (state.activity) {
        const rows = state.activity.runs;
        const counts = new Map();
        for (const row of rows) {
          const label = row.job?.label || "Unknown";
          counts.set(label, (counts.get(label) || 0) + 1);
        }
        activitySummary.textContent = `${[...counts].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ")}. Job state checked every 30s; metric activity is separate.`;
      } else activitySummary.textContent = "Run activity unavailable";

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
        opt.textContent = `${activityLabel(activityByName.get(rName))} · ${rName}`;
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
          if (!matchesJobFilter(state, s.run)) continue;
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
          const badge = document.createElement("span");
          const activity = activityByName.get(s.run);
          badge.textContent = activityLabel(activity);
          badge.style.color = activity?.job?.status === "running" ? "#4ade80" : activity?.job?.status === "failed" ? "#fb7185" : "#a2b2d4";
          chip.title = `${activity?.job?.source || "Unknown source"} · ${activity?.job?.checkedAt || "not checked"}\n${activity?.job?.detail || ""}`;
          chip.append(swatch, runLabel, badge);
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
      if (window.__piTrackioStandalone) return;
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
      if (state.fetching) { state.fetchAgain = true; return; }
      state.fetching = true;
      const requestedProject = state.project;
      const previousJobs = JSON.stringify((state.activity?.runs || []).map(r => r.job?.status));
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
          allRuns: state.allRuns,
        });
        if (state.project && state.project !== requestedProject) return;
        try {
          const response = await fetch(`/__trackio/activity?project=${encodeURIComponent(payload.project)}`);
          state.activity = response.ok ? await response.json() : null;
        } catch { state.activity = null; }
        if (state.project && state.project !== requestedProject) return;
        if (state.jobFilter !== "all" && previousJobs !== JSON.stringify((state.activity?.runs || []).map(r => r.job?.status))) forceRebuild = true;
        state.allProjectRuns = payload.allRuns;
        const prevMetricsKey = (state.data?.availableMetrics || []).join("|");
        const nextMetricsKey = (payload.availableMetrics || []).join("|");
        state.data = payload;
        if (!state.project && payload.project) state.project = payload.project;
        state.loading = false;
        state.error = null;
        popBtn.href = buildTrackioAppUrl(state);
        rebuildRunsAndSummary();
        if (state.mode === "dashboard") refreshDashboard();
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
      } finally {
        state.fetching = false;
        if (state.fetchAgain || (requestedProject && requestedProject !== state.project)) {
          state.fetchAgain = false;
          void fetchAndRender(true);
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
        plotObserver.disconnect();
        resizeObserver.disconnect();
        return;
      }
      if (document.hidden) return;
      if (state.mode === "dashboard" && state.project) {
        const project = state.project;
        void fetch(`/__trackio/activity?project=${encodeURIComponent(project)}`)
          .then(response => response.ok ? response.json() : null)
          .then(activity => { if (project === state.project) { state.activity = activity; rebuildRunsAndSummary(); } })
          .catch(() => {});
        return;
      }
      if (!state.live) return;
      void fetchAndRender(false);
    }, 4000);

    const resizeObserver = new ResizeObserver(() => {
      if (state.mode === "chart") repaintPlots();
    });
    resizeObserver.observe(root);

    return { root, updateSpec, state };
  }

  function extractCodeBlockText(block) {
    const pre = block.querySelector("pre");
    if (!pre) return "";
    const codeNodes = pre.querySelectorAll("code");
    const target = codeNodes.length > 0 ? codeNodes[codeNodes.length - 1] : pre;
    const clone = target.cloneNode(true);
    for (const ln of clone.querySelectorAll(
      ".react-syntax-highlighter-line-number, .linenumber, [style*='user-select: none'], [style*='user-select:none']",
    )) {
      ln.remove();
    }
    return (clone.textContent || "").trim();
  }

  function parseTrackioBlockSpec(rawText) {
    if (!rawText) return null;
    const trimmed = rawText.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // Fallback: strip any leftover leading line numbers per line
        const stripped = trimmed
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*\d+\s+(?=[{"\]\}\s])/, "").replace(/^\s*\d+(?=[{}])/, ""))
          .join("\n");
        try {
          return JSON.parse(stripped);
        } catch {
          return null;
        }
      }
    }
    if (/^[A-Za-z0-9_.-]{1,80}$/.test(trimmed)) {
      return { project: trimmed };
    }
    return null;
  }

  function mountInlineCard(block, spec) {
    block.classList.add("pi-trackio-upgraded");
    const existing = block.querySelector(":scope > .pi-trackio-card");
    if (existing) existing.remove();
    const explorer = createInteractiveExplorer(spec, { isSidePanel: false });
    block.append(explorer.root);
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

  function openComputeDock() {
    const existing = document.getElementById(COMPUTE_DOCK_ID);
    if (existing) {
      existing.remove();
      document.getElementById(COMPUTE_TOOLBAR_ID)?.setAttribute("aria-expanded", "false");
      return;
    }
    document.getElementById(DOCK_ID)?.remove();
    document.getElementById(TOOLBAR_ID)?.setAttribute("aria-expanded", "false");

    const dock = document.createElement("aside");
    dock.id = COMPUTE_DOCK_ID;
    dock.className = "pi-compute-dock";
    dock.setAttribute("aria-label", "Active compute dashboard");
    const grip = document.createElement("div");
    grip.className = "pi-compute-grip";
    grip.title = "Drag to resize split-screen panel";
    let dragging = false;
    grip.addEventListener("pointerdown", (e) => {
      dragging = true;
      grip.classList.add("is-dragging");
      e.preventDefault();
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging || !dock.isConnected) return;
      const width = Math.max(360, Math.min(window.innerWidth - e.clientX, window.innerWidth * 0.85));
      dock.style.setProperty("--pi-compute-width", `${width}px`);
    });
    window.addEventListener("pointerup", () => {
      dragging = false;
      grip.classList.remove("is-dragging");
    });

    const header = document.createElement("div");
    header.className = "pi-compute-header";
    const title = document.createElement("strong");
    title.textContent = "⚡ Active compute";
    const label = document.createElement("span");
    label.textContent = "Modal · GCP · SF Compute";
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    const pop = document.createElement("a");
    pop.className = "pi-trackio-btn";
    pop.href = COMPUTE_URL;
    pop.target = "_blank";
    pop.rel = "noopener noreferrer";
    pop.textContent = "↗";
    pop.title = "Open active compute dashboard in a new tab";
    pop.setAttribute("aria-label", pop.title);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "pi-trackio-btn";
    close.textContent = "✕";
    close.title = "Close active compute dashboard";
    close.setAttribute("aria-label", close.title);
    close.onclick = () => {
      dock.remove();
      document.getElementById(COMPUTE_TOOLBAR_ID)?.setAttribute("aria-expanded", "false");
    };
    header.append(title, label, spacer, pop, close);
    const body = document.createElement("div");
    body.className = "pi-compute-body";
    const iframe = document.createElement("iframe");
    iframe.src = COMPUTE_URL + "?embed=1";
    iframe.title = "Active compute dashboard";
    iframe.loading = "eager";
    iframe.style.cssText = "flex:1;width:100%;height:100%;border:0;background:#0d1326;display:block";
    body.append(iframe);
    dock.append(grip, header, body);
    const { parent, before } = findSplitScreenHost();
    if (before) parent.insertBefore(dock, before);
    else parent.append(dock);
    document.getElementById(COMPUTE_TOOLBAR_ID)?.setAttribute("aria-expanded", "true");
  }

  function openDock(spec = {}) {
    if (document.getElementById(COMPUTE_DOCK_ID)) {
      document.getElementById(COMPUTE_DOCK_ID)?.remove();
      document.getElementById(COMPUTE_TOOLBAR_ID)?.setAttribute("aria-expanded", "false");
    }
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
  window.__piComputeOpenDock = openComputeDock;

  if (window.__piTrackioStandalone) {
    const explorer = createInteractiveExplorer(window.__piTrackioStandalone, { isSidePanel: true });
    document.getElementById("pi-trackio-standalone").append(explorer.root);
    return;
  }

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

    if (!document.getElementById(COMPUTE_TOOLBAR_ID)) {
      const trackioBtn = document.getElementById(TOOLBAR_ID);
      const anchor = trackioBtn ||
        document.getElementById("pi-web-tmux-toolbar") ||
        document.querySelector('button[aria-controls="file-panel"]');
      if (anchor?.parentElement) {
        const btn = document.createElement("button");
        btn.id = COMPUTE_TOOLBAR_ID;
        btn.type = "button";
        btn.title = "Toggle the active-compute dashboard (Modal · GCP · SF Compute)";
        btn.setAttribute("aria-controls", COMPUTE_DOCK_ID);
        btn.setAttribute("aria-expanded", String(Boolean(document.getElementById(COMPUTE_DOCK_ID))));
        btn.append(document.createTextNode("⚡ Compute"));
        btn.style.cssText =
          "display:inline-flex;align-items:center;min-height:44px;padding:0 10px;border:none;background:transparent;color:var(--text-dim,#a2b2d4);font:inherit;font-size:12px;cursor:pointer;flex-shrink:0";
        btn.onclick = () => openComputeDock();
        anchor.parentElement.insertBefore(btn, trackioBtn ? trackioBtn.nextSibling : anchor);
      }
    }

    const codeBlocks = document.querySelectorAll(".markdown-code-block");
    for (const block of codeBlocks) {
      if (block.dataset.trackioMounted && block.querySelector(":scope > .pi-trackio-card")) continue;
      const langNode = block.querySelector(".markdown-code-lang");
      const lang = (langNode?.textContent || "").trim().toLowerCase();
      if (lang !== "trackio") continue;
      const rawText = extractCodeBlockText(block);
      const parsedSpec = parseTrackioBlockSpec(rawText);
      if (!parsedSpec || typeof parsedSpec !== "object") continue;
      block.dataset.trackioMounted = "1";
      mountInlineCard(block, parsedSpec);
    }

    const links = document.querySelectorAll(
      '.markdown-body a[href*="/__trackio"], .markdown-body a[href*="127.0.0.1:30143"], .markdown-body a[href*="localhost:30143"], .markdown-body a[href^="trackio://"], .markdown-body a[href*="trackio.local"]',
    );
    for (const link of links) {
      if (
        link.dataset.trackioEnhanced ||
        link.classList.contains("pi-trackio-btn") ||
        link.classList.contains("pi-trackio-ext-tab")
      ) {
        continue;
      }
      const origHref = link.getAttribute("href") || "";
      if (isComputeHref(origHref)) continue;
      const parsed = parseTrackioLinkHref(origHref);
      if (!parsed) continue;
      link.dataset.trackioEnhanced = "1";
      link.dataset.trackioSpec = JSON.stringify(parsed);
      link.classList.add("pi-trackio-dashboard-link");
      const sameOriginUrl = buildTrackioAppUrl(parsed);
      link.setAttribute("href", sameOriginUrl);
      // Setting target="_blank" prevents pi-web's React onClick from treating /__trackio/* as a local file path
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      link.title = "Click to open in Trackio split-screen side panel";

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

  // Window capture-phase listener runs BEFORE React's root click delegation
  window.addEventListener(
    "click",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      if (anchor.classList.contains("pi-trackio-ext-tab") || anchor.classList.contains("pi-trackio-btn")) {
        return;
      }
      if (isComputeHref(anchor.getAttribute("href") || "")) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        openComputeDock();
        return;
      }
      let parsed = null;
      if (anchor.dataset.trackioSpec) {
        try {
          parsed = JSON.parse(anchor.dataset.trackioSpec);
        } catch {
          parsed = null;
        }
      }
      if (!parsed) {
        parsed = parseTrackioLinkHref(anchor.getAttribute("href") || "");
      }
      if (!parsed) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openDock(parsed);
    },
    true,
  );

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
