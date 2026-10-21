import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { trackioClient, type PlotSeriesPayload } from "./client.ts";
import { attachTrackioRoutes, findPiWebServer } from "./web-proxy.ts";

export const TRACKIO_EMBED_TYPE = "trackio-embed";

export interface TrackioEmbedSpec {
  title?: string;
  project?: string;
  runs?: string[];
  metrics?: string[];
  x_axis?: string;
  smoothing?: number;
  log_x?: boolean;
  log_y?: boolean;
  page?: "metrics" | "system" | "runs" | "traces" | "media" | "reports" | "artifacts" | "files" | "settings";
  mode?: "chart" | "dashboard";
  live?: boolean;
  open_side_panel?: boolean;
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function buildSparkline(values: number[], width = 24): string {
  if (!values.length) return "—";
  const sampled: number[] = [];
  if (values.length <= width) {
    sampled.push(...values);
  } else {
    const step = (values.length - 1) / (width - 1);
    for (let i = 0; i < width - 1; i++) sampled.push(values[Math.floor(i * step)]);
    sampled.push(values[values.length - 1]);
  }
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "—";
  if (max === min) return SPARK_CHARS[3].repeat(sampled.length);
  return sampled
    .map((v) => {
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.max(0, Math.round(((v - min) / (max - min)) * (SPARK_CHARS.length - 1))),
      );
      return SPARK_CHARS[idx];
    })
    .join("");
}

function formatNum(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs < 0.001 || abs >= 100000) return v.toExponential(3);
  if (abs < 1) return v.toFixed(4);
  if (abs < 100) return v.toFixed(3);
  return v.toFixed(2);
}

export function buildAppUrl(spec: TrackioEmbedSpec): string {
  const pageMap: Record<string, string> = {
    metrics: "/",
    system: "/system",
    runs: "/runs",
    traces: "/traces",
    media: "/media",
    reports: "/reports",
    artifacts: "/artifacts",
    files: "/files",
    settings: "/settings",
  };
  const pagePath = pageMap[spec.page ?? "metrics"] ?? "/";
  const params = new URLSearchParams();
  if (spec.project) params.set("project", spec.project);
  if (spec.runs?.length) params.set("runs", spec.runs.join(","));
  if (spec.metrics?.length) params.set("metrics", spec.metrics.join(","));
  if (spec.x_axis && spec.x_axis !== "step") params.set("x_axis", spec.x_axis);
  if (spec.smoothing !== undefined) params.set("smoothing", String(spec.smoothing));
  const qs = params.toString();
  return `/__trackio/app${pagePath}${qs ? `?${qs}` : ""}`;
}

export function formatSeriesTextSummary(seriesPayload: PlotSeriesPayload, spec: TrackioEmbedSpec): string {
  const lines: string[] = [];
  const appUrl = buildAppUrl({ ...spec, project: seriesPayload.project });
  lines.push(
    `[📈 Open ${seriesPayload.project || "Trackio"} in Split-Screen Dashboard](${appUrl}) (${seriesPayload.selectedRuns.length}/${seriesPayload.allRuns.length} runs)`,
  );

  if (seriesPayload.series.length > 0) {
    const runLinks = seriesPayload.series
      .slice(0, 6)
      .map((s) => `[${s.run}](${buildAppUrl({ project: seriesPayload.project, runs: [s.run] })})`)
      .join(" · ");
    lines.push(`Per-run links: ${runLinks}`);
  }

  for (const metric of seriesPayload.selectedMetrics.slice(0, 8)) {
    lines.push(`  Metric: ${metric}`);
    for (const s of seriesPayload.series) {
      const pts = s.metrics[metric] ?? [];
      if (!pts.length) continue;
      const vals = pts.map((p) => p.value);
      const spark = buildSparkline(vals, 20);
      const firstVal = vals[0];
      const lastVal = s.latest[metric];
      const delta =
        firstVal !== undefined && lastVal !== undefined && pts.length > 1
          ? `  Δ=${lastVal - firstVal >= 0 ? "+" : ""}${formatNum(lastVal - firstVal)}`
          : "";
      lines.push(
        `    • ${s.run.padEnd(22)} ${spark}  start=${formatNum(firstVal)}  latest=${formatNum(lastVal)}  min=${formatNum(s.min[metric])}  max=${formatNum(s.max[metric])}${delta} (${pts.length} pts)`,
      );
    }
  }
  return lines.join("\n");
}

function ensurePiWebMounted(): boolean {
  const server = findPiWebServer();
  if (!server) return false;
  return attachTrackioRoutes(server);
}

export default function piTrackioExtension(pi: ExtensionAPI) {
  // Attach HTTP routes if running inside pi-web
  ensurePiWebMounted();
  pi.on("session_start", () => {
    ensurePiWebMounted();
  });

  // Strip UI-only trackio-embed custom messages from LLM context
  pi.on("context", (event) => {
    const filtered = event.messages.filter((m: AgentMessage) => {
      const custom = m as { role?: string; customType?: string };
      return !(custom.role === "custom" && custom.customType === TRACKIO_EMBED_TYPE);
    });
    if (filtered.length === event.messages.length) return undefined;
    return { messages: filtered };
  });

  // TUI renderer for trackio-embed custom messages
  pi.registerMessageRenderer<TrackioEmbedSpec & { textSummary?: string }>(
    TRACKIO_EMBED_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details;
      const title = details?.title ?? `Trackio · ${details?.project ?? "Dashboard"}`;
      const header =
        theme.fg("accent", "◆ ") +
        theme.fg("toolTitle", theme.bold(title)) +
        (details?.project ? theme.fg("dim", ` [${details.project}]`) : "");
      if (!expanded && details?.textSummary) {
        const firstLine = details.textSummary.split("\n").slice(0, 4).join("\n");
        return new Text(`${header}\n${firstLine}`, 0, 0);
      }
      return new Text(`${header}\n${details?.textSummary ?? ""}`, 0, 0);
    },
  );

  // --- Tool 1: trackio_status ------------------------------------------------
  pi.registerTool({
    name: "trackio_status",
    label: "Trackio Status & GCS Backup",
    description:
      "Inspect local Trackio server health, projects, run counts, SQLite DB files, and GCS backup status. Set backup_now=true to run an immediate online SQLite snapshot + GCS rsync.",
    parameters: Type.Object({
      backup_now: Type.Optional(
        Type.Boolean({
          description: "Trigger an immediate online SQLite backup and sync to GCS (default false)",
        }),
      ),
      local_only: Type.Optional(
        Type.Boolean({
          description: "When backup_now=true, only snapshot locally without pushing to GCS",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      ensurePiWebMounted();
      let backupResult: { ok: boolean; output: string; lastBackupUtc: string | null; gcsBucket: string | null } | null =
        null;
      if (params.backup_now) {
        backupResult = await trackioClient.triggerBackup({ localOnly: params.local_only });
      }
      const status = await trackioClient.getStatus();
      const lines = [
        `Trackio Server: ${status.healthy ? "ONLINE" : "OFFLINE"} (${status.serverUrl}, v${status.version ?? "unknown"})`,
        `Data Dir      : ${status.trackioDir} (${status.dbFiles.length} SQLite DBs)`,
        `GCS Bucket    : ${status.gcsBucket ?? "(not configured)"}`,
        `Last Backup   : ${status.lastBackupUtc ?? "(none)"}`,
        `Projects (${status.projects.length}): ${
          status.projects.map((p) => `${p} (${status.projectRunCounts[p] ?? 0} runs)`).join(", ") || "none"
        }`,
      ];
      if (backupResult) {
        lines.push(`Backup Result : ${backupResult.output}`);
      }
      if (status.error) {
        lines.push(`Error         : ${status.error}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { status, backupResult },
      };
    },
  });

  // --- Tool 2: trackio_query -------------------------------------------------
  pi.registerTool({
    name: "trackio_query",
    label: "Trackio Query",
    description:
      "Query Trackio projects, runs, hyperparameter configs, scalar metric logs, system/GPU telemetry, or run a read-only SQL query against a project's SQLite DB.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("projects"),
          Type.Literal("project_summary"),
          Type.Literal("runs"),
          Type.Literal("run_summary"),
          Type.Literal("metrics"),
          Type.Literal("system"),
          Type.Literal("sql"),
        ],
        { description: "Query action to perform" },
      ),
      project: Type.Optional(Type.String({ description: "Trackio project name" })),
      run: Type.Optional(Type.String({ description: "Run name (for run_summary, metrics, or system)" })),
      runs: Type.Optional(Type.Array(Type.String(), { description: "Run names (for batch metrics/system)" })),
      metrics: Type.Optional(Type.Array(Type.String(), { description: "Metric names or regex filters" })),
      sql: Type.Optional(
        Type.String({
          description: "Read-only SQL query when action='sql' (tables: metrics, configs, system_metrics, etc.)",
        }),
      ),
      max_points: Type.Optional(Type.Number({ description: "Max points per series (default 200)" })),
    }),
    async execute(_toolCallId, params) {
      ensurePiWebMounted();
      const action = params.action;

      if (action === "projects") {
        const projects = await trackioClient.listProjects();
        return {
          content: [{ type: "text", text: JSON.stringify({ projects }, null, 2) }],
          details: { projects } as Record<string, unknown>,
        };
      }

      const allProjects = await trackioClient.listProjects();
      const project = params.project || allProjects[0];
      if (!project) {
        return {
          content: [{ type: "text", text: "No Trackio projects found." }],
          details: { projects: [] } as Record<string, unknown>,
        };
      }

      if (action === "project_summary") {
        const summary = await trackioClient.getProjectSummary(project);
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: { project, summary } as Record<string, unknown>,
        };
      }

      if (action === "runs") {
        const [runs, configs] = await Promise.all([
          trackioClient.listRuns(project),
          trackioClient.getRunConfigs(project),
        ]);
        return {
          content: [{ type: "text", text: JSON.stringify({ project, runs, configs }, null, 2) }],
          details: { project, runs, configs } as Record<string, unknown>,
        };
      }

      if (action === "run_summary") {
        const runs = await trackioClient.listRuns(project);
        const run = params.run || runs[0]?.name;
        if (!run) {
          return {
            content: [{ type: "text", text: `No runs found in project ${project}.` }],
            details: { project, runs: [] } as Record<string, unknown>,
          };
        }
        const summary = await trackioClient.getRunSummary(project, run);
        return {
          content: [{ type: "text", text: JSON.stringify({ project, run, summary }, null, 2) }],
          details: { project, run, summary } as Record<string, unknown>,
        };
      }

      if (action === "system") {
        const runs = await trackioClient.listRuns(project);
        const targetRuns = params.runs?.length
          ? params.runs
          : params.run
            ? [params.run]
            : runs.slice(0, 4).map((r) => r.name);
        const sysLogs = await trackioClient.getSystemLogsBatch(project, targetRuns);
        return {
          content: [{ type: "text", text: JSON.stringify({ project, runs: targetRuns, system: sysLogs }, null, 2) }],
          details: { project, runs: targetRuns, system: sysLogs } as Record<string, unknown>,
        };
      }

      if (action === "sql") {
        if (!params.sql) {
          throw new Error("sql parameter is required when action='sql'");
        }
        const result = await trackioClient.querySql(project, params.sql);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { project, sql: params.sql, result } as Record<string, unknown>,
        };
      }

      // action === "metrics"
      const series = await trackioClient.getPlotSeries({
        project,
        runs: params.runs?.length ? params.runs : params.run ? [params.run] : undefined,
        metrics: params.metrics,
        maxPoints: params.max_points ?? 200,
      });
      const text = formatSeriesTextSummary(series, { project, runs: params.runs, metrics: params.metrics });
      return {
        content: [{ type: "text", text }],
        details: series as unknown as Record<string, unknown>,
      };
    },
  });

  // --- Tool 3: trackio_plot --------------------------------------------------
  pi.registerTool({
    name: "trackio_plot",
    label: "Trackio Interactive Plot / Dashboard",
    description:
      "Embed an interactive Trackio multi-run chart or live dashboard natively inside pi-web (with EMA smoothing, log scale, zoom, hover crosshair, run toggles, and split-panel dock) and return a sparkline summary.",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Trackio project name (defaults to latest project)" })),
      runs: Type.Optional(Type.Array(Type.String(), { description: "Optional subset of run names to compare" })),
      metrics: Type.Optional(
        Type.Array(Type.String(), { description: "Metric names or regex patterns to display (default: all)" }),
      ),
      x_axis: Type.Optional(Type.String({ description: "X-axis column: 'step' (default), 'time', or metric name" })),
      smoothing: Type.Optional(Type.Number({ description: "EMA smoothing slider 0..95 (default 10)" })),
      log_x: Type.Optional(Type.Boolean({ description: "Logarithmic X-axis" })),
      log_y: Type.Optional(Type.Boolean({ description: "Logarithmic Y-axis" })),
      page: Type.Optional(
        Type.Union([
          Type.Literal("metrics"),
          Type.Literal("system"),
          Type.Literal("runs"),
          Type.Literal("traces"),
          Type.Literal("media"),
          Type.Literal("reports"),
          Type.Literal("artifacts"),
          Type.Literal("files"),
        ]),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("chart"), Type.Literal("dashboard")], {
          description: "'chart' = native interactive canvas plots (default); 'dashboard' = full Trackio Svelte UI",
        }),
      ),
      title: Type.Optional(Type.String({ description: "Card title shown in pi-web" })),
      live: Type.Optional(Type.Boolean({ description: "Auto-poll live updates every 4s (default true)" })),
      open_side_panel: Type.Optional(
        Type.Boolean({
          description: "Automatically open the split-screen Trackio side panel in pi-web (default false)",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      ensurePiWebMounted();
      const series = await trackioClient.getPlotSeries({
        project: params.project,
        runs: params.runs,
        metrics: params.metrics,
        xAxis: params.x_axis,
      });

      const spec: TrackioEmbedSpec = {
        title: params.title ?? (series.project ? `Trackio · ${series.project}` : "Trackio"),
        project: series.project,
        runs: params.runs,
        metrics: params.metrics,
        x_axis: params.x_axis ?? "step",
        smoothing: params.smoothing ?? 10,
        log_x: params.log_x ?? false,
        log_y: params.log_y ?? false,
        page: params.page ?? "metrics",
        mode: params.mode ?? (params.page && params.page !== "metrics" ? "dashboard" : "chart"),
        live: params.live ?? true,
        open_side_panel: params.open_side_panel ?? false,
      };

      const textSummary = formatSeriesTextSummary(series, spec);
      const embedMarkdown = "```trackio\n" + JSON.stringify(spec, null, 2) + "\n```";

      // Post the interactive card into the pi-web stream without triggering an extra turn
      pi.sendMessage(
        {
          customType: TRACKIO_EMBED_TYPE,
          content: embedMarkdown,
          display: true,
          details: { ...spec, textSummary },
        },
        { triggerTurn: false },
      );

      return {
        content: [{ type: "text", text: `${textSummary}\n\n${embedMarkdown}` }],
        details: { spec, series },
      };
    },
  });

  // --- Tool 4: trackio_log ---------------------------------------------------
  pi.registerTool({
    name: "trackio_log",
    label: "Trackio Log Metrics",
    description:
      "Log scalar metrics and hyperparameter configs directly to the local Trackio server (drop-in W&B replacement).",
    parameters: Type.Object({
      project: Type.String({ description: "Trackio project name" }),
      run: Type.Optional(Type.String({ description: "Run name (resumes if existing, or creates new)" })),
      config: Type.Optional(
        Type.Record(Type.String(), Type.Any(), { description: "Hyperparameter/configuration dictionary" }),
      ),
      metrics: Type.Union(
        [
          Type.Record(Type.String(), Type.Union([Type.Number(), Type.String(), Type.Boolean()])),
          Type.Array(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String(), Type.Boolean()]))),
        ],
        { description: "Single metric dict or array of metric dicts (may include 'step')" },
      ),
      step: Type.Optional(Type.Number({ description: "Optional explicit step number" })),
    }),
    async execute(_toolCallId, params) {
      ensurePiWebMounted();
      const res = await trackioClient.logMetrics({
        project: params.project,
        run: params.run,
        config: params.config as Record<string, unknown> | undefined,
        metrics: params.metrics as
          | Record<string, number | string | boolean>
          | Array<Record<string, number | string | boolean>>,
        step: params.step,
      });
      return {
        content: [
          {
            type: "text",
            text: `Logged ${res.loggedSteps} step(s) to Trackio project="${res.project}" run="${res.run}".`,
          },
        ],
        details: res,
      };
    },
  });

  // --- Slash command: /trackio -----------------------------------------------
  pi.registerCommand("trackio", {
    description: "Open interactive Trackio charts/dashboard in pi-web, check status, or trigger GCS backup",
    handler: async (args, ctx) => {
      ensurePiWebMounted();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "plot";

      if (sub === "status") {
        const status = await trackioClient.getStatus();
        ctx.ui.notify(
          `Trackio ${status.healthy ? "online" : "OFFLINE"} (${status.projects.length} projects, GCS: ${status.gcsBucket ?? "none"}, last backup: ${status.lastBackupUtc ?? "never"})`,
          status.healthy ? "info" : "warning",
        );
        return;
      }

      if (sub === "backup") {
        const res = await trackioClient.triggerBackup();
        ctx.ui.notify(`Trackio backup complete (${res.lastBackupUtc ?? "now"})`, "info");
        return;
      }

      const project = sub === "plot" || sub === "dashboard" ? parts[1] : parts[0];
      const metrics = (sub === "plot" || sub === "dashboard" ? parts.slice(2) : parts.slice(1)).filter(Boolean);
      const series = await trackioClient.getPlotSeries({
        project,
        metrics: metrics.length ? metrics : undefined,
      });
      const spec: TrackioEmbedSpec = {
        title: series.project ? `Trackio · ${series.project}` : "Trackio Dashboard",
        project: series.project,
        metrics: metrics.length ? metrics : undefined,
        mode: sub === "dashboard" ? "dashboard" : "chart",
        live: true,
      };
      const textSummary = formatSeriesTextSummary(series, spec);
      pi.sendMessage(
        {
          customType: TRACKIO_EMBED_TYPE,
          content: "```trackio\n" + JSON.stringify(spec, null, 2) + "\n```",
          display: true,
          details: { ...spec, textSummary },
        },
        { triggerTurn: false },
      );
    },
  });
}
