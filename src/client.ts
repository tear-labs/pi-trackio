import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TrackioEnvConfig {
  serverUrl: string;
  host: string;
  port: number;
  writeToken: string;
  trackioDir: string;
  backupDir: string;
  backupScript: string;
  gcsBucket: string;
  googleCredentials: string;
}

export interface TrackioStatus {
  healthy: boolean;
  version: string | null;
  serverUrl: string;
  trackioDir: string;
  backupDir: string;
  gcsBucket: string | null;
  lastBackupUtc: string | null;
  projects: string[];
  projectRunCounts: Record<string, number>;
  dbFiles: Array<{ name: string; sizeBytes: number; mtimeIso: string }>;
  error?: string;
}

export interface SeriesPoint {
  step: number;
  time?: number | string | null;
  value: number;
}

export interface RunSeries {
  run: string;
  colorIndex: number;
  config: Record<string, unknown>;
  metrics: Record<string, SeriesPoint[]>;
  latest: Record<string, number>;
  min: Record<string, number>;
  max: Record<string, number>;
}

export interface PlotSeriesPayload {
  project: string;
  allProjects: string[];
  allRuns: string[];
  selectedRuns: string[];
  availableMetrics: string[];
  selectedMetrics: string[];
  xAxis: string;
  series: RunSeries[];
  fetchedAt: string;
}

const FORBIDDEN_SQL_RE =
  /\b(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|REINDEX|ANALYZE|LOAD_EXTENSION)\b/i;

export function validateReadOnlySql(rawSql: string): string {
  const trimmed = rawSql.trim().replace(/;+\s*$/, "").trim();
  if (!trimmed) {
    throw new Error("SQL query cannot be empty.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only a single read-only SELECT/WITH statement is allowed.");
  }
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT or WITH queries are permitted.");
  }
  if (FORBIDDEN_SQL_RE.test(trimmed)) {
    throw new Error("Query contains forbidden non-read-only SQL keywords.");
  }
  return trimmed;
}

export function metricPriorityScore(metricName: string): number {
  const m = metricName.toLowerCase();
  if (m === "loss" || m === "train/loss" || m === "train/ce" || m === "ce") return 0;
  if (m === "val/loss" || m === "eval/loss" || m === "val/ce" || m === "val/ce_student" || m === "eval/heldout_ce" || m === "eval/heldout/fixed_t_ce") return 1;
  if (/(?:^|\/)(?:loss|ce|nll|ppl|perplexity)(?:$|\/|_)/i.test(m) && !m.startsWith("time/")) return 2;
  if (/(?:^|\/)(?:kl|rkl|top1_agree|acc|accuracy|auroc|win_rate|is_human|mean|coherence|score|reward)(?:$|\/|_)/i.test(m)) return 3;
  if (/(?:^|\/)(?:grad_norm|lr|learning_rate|update_rms)(?:$|\/|_)/i.test(m)) return 4;
  if (/(?:^|\/)(?:tok_per_s|target_tokens_per_second|mfu|update_seconds|step_time|mem_gb|peak_memory)(?:$|\/|_)/i.test(m)) return 5;
  if (m.startsWith("train/") || m.startsWith("val/") || m.startsWith("eval/")) return 6;
  if (m.startsWith("perf/") || m.startsWith("opt/") || m.startsWith("ffn_opt/")) return 7;
  return 10;
}

export function sortMetricsByPriority(metrics: string[]): string[] {
  return [...metrics].sort((a, b) => {
    const pa = metricPriorityScore(a);
    const pb = metricPriorityScore(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

export function matchesMetricPattern(metricName: string, rawPattern: string): boolean {
  const pat = rawPattern.trim().slice(0, 120);
  if (!pat) return true;
  if (pat === metricName) return true;
  // Reject potentially catastrophic nested quantifier patterns before RegExp compilation
  if (/(\*|\+|\{[0-9,]+\})\s*\)[*+?]/.test(pat)) {
    return metricName.toLowerCase().includes(pat.toLowerCase());
  }
  try {
    return new RegExp(pat, "i").test(metricName);
  } catch {
    return metricName.toLowerCase().includes(pat.toLowerCase());
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    // ignore read errors
  }
  return out;
}

export function loadTrackioConfig(): TrackioEnvConfig {
  const home = homedir();
  const envFile = parseEnvFile(join(home, ".config", "trackio.env"));
  const get = (key: string, fallback = ""): string => {
    const v = process.env[key] ?? envFile[key] ?? fallback;
    return v.replace(/^~(?=\/|$)/, home);
  };

  const host = get("TRACKIO_HOST", "127.0.0.1");
  const port = Number(get("TRACKIO_PORT", "30143")) || 30143;
  const serverUrl = get("TRACKIO_SERVER_URL", `http://${host}:${port}`).replace(/\/+$/, "");
  const writeToken = get("TRACKIO_WRITE_TOKEN", "");
  const trackioDir = resolve(get("TRACKIO_DIR", join(home, ".local", "share", "trackio", "data")));
  const backupDir = resolve(get("TRACKIO_BACKUP_DIR", join(home, ".local", "share", "trackio", "backups", "latest")));
  const backupScript = resolve(
    get("TRACKIO_BACKUP_SCRIPT", join(home, ".local", "share", "trackio", "backup-gcs.sh")),
  );
  const gcsBucket = get("TRACKIO_GCS_BUCKET", "");
  const googleCredentials = get("GOOGLE_APPLICATION_CREDENTIALS", "");

  return {
    serverUrl,
    host,
    port,
    writeToken,
    trackioDir,
    backupDir,
    backupScript,
    gcsBucket,
    googleCredentials,
  };
}

export class TrackioClient {
  private seriesCache = new Map<string, { ts: number; data: PlotSeriesPayload }>();
  private seriesInFlight = new Map<string, Promise<PlotSeriesPayload>>();

  private get cfg(): TrackioEnvConfig {
    return loadTrackioConfig();
  }

  public getConfig(): TrackioEnvConfig {
    return this.cfg;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const { writeToken } = this.cfg;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(extra ?? {}),
    };
    if (writeToken) {
      headers["x-trackio-write-token"] = writeToken;
      headers["cookie"] = `trackio_write_token=${encodeURIComponent(writeToken)}`;
    }
    return headers;
  }

  public async getVersion(timeoutMs = 3000): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.cfg.serverUrl}/version`, {
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: string };
      return data.version ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  public async callApi<T = unknown>(
    apiName: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10000,
  ): Promise<T> {
    const clean = apiName.startsWith("/") ? apiName.slice(1) : apiName;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.cfg.serverUrl}/api/${clean}`, {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(params),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Trackio API ${clean} failed (${res.status}): ${text.slice(0, 240)}`);
        }
        const json = (await res.json()) as { data?: T; error?: string };
        if (json.error) {
          throw new Error(json.error);
        }
        return json.data as T;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 150));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  public async listProjects(): Promise<string[]> {
    const data = await this.callApi<string[]>("get_all_projects");
    return Array.isArray(data) ? data : [];
  }

  public async getProjectSummary(project: string): Promise<Record<string, unknown>> {
    return (await this.callApi<Record<string, unknown>>("get_project_summary", { project })) ?? {};
  }

  public async listRuns(project: string): Promise<Array<{ id?: string | number | null; name: string }>> {
    const raw = await this.callApi<Array<string | { id?: string | number | null; name: string }>>(
      "get_runs_for_project",
      { project },
    );
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => (typeof item === "string" ? { name: item, id: null } : item));
  }

  public async getRunSummary(project: string, run: string): Promise<Record<string, unknown>> {
    return (await this.callApi<Record<string, unknown>>("get_run_summary", { project, run, run_id: null })) ?? {};
  }

  public async getRunConfigs(project: string): Promise<Record<string, Record<string, unknown>>> {
    return (
      (await this.callApi<Record<string, Record<string, unknown>>>("get_run_configs", { project }).catch(
        () => ({}),
      )) ?? {}
    );
  }

  public async listMetricsForRun(project: string, run: string): Promise<string[]> {
    const data = await this.callApi<string[]>("get_metrics_for_run", { project, run, run_id: null });
    return Array.isArray(data) ? data : [];
  }

  public async getLogsBatch(
    project: string,
    runs: string[],
    options: { downsample?: number; metrics?: string[] } = {},
  ): Promise<Array<{ run: string; run_id?: string | null; logs: Array<Record<string, unknown>> }>> {
    const payload: Record<string, unknown> = {
      project,
      runs: runs.map((r) => ({ run: r, run_id: null })),
      ...options,
    };
    const data = await this.callApi<
      Array<{ run: string; run_id?: string | null; logs: Array<Record<string, unknown>> }>
    >("get_logs_batch", payload);
    return Array.isArray(data) ? data : [];
  }

  public async getSystemMetricsForRun(project: string, run: string): Promise<string[]> {
    const data = await this.callApi<string[]>("get_system_metrics_for_run", { project, run, run_id: null }).catch(
      () => [],
    );
    return Array.isArray(data) ? data : [];
  }

  public async getSystemLogsBatch(
    project: string,
    runs: string[],
  ): Promise<Array<{ run: string; logs: Array<Record<string, unknown>> }>> {
    const data = await this.callApi<Array<{ run: string; logs: Array<Record<string, unknown>> }>>(
      "get_system_logs_batch",
      {
        project,
        runs: runs.map((r) => ({ run: r, run_id: null })),
      },
    ).catch(() => []);
    return Array.isArray(data) ? data : [];
  }

  public async querySql(project: string, sql: string): Promise<unknown> {
    const safeSql = validateReadOnlySql(sql);
    try {
      return await this.callApi("query_project", { project, query: safeSql });
    } catch {
      const trackioBin = existsSync(join(homedir(), ".local", "bin", "trackio"))
        ? join(homedir(), ".local", "bin", "trackio")
        : "trackio";
      const { stdout } = await execFileAsync(
        trackioBin,
        ["query", "project", "--project", project, "--sql", safeSql, "--json"],
        {
          env: { ...process.env, TRACKIO_DIR: this.cfg.trackioDir },
          timeout: 15000,
        },
      );
      return JSON.parse(stdout);
    }
  }

  public async logMetrics(params: {
    project: string;
    run?: string;
    config?: Record<string, unknown>;
    metrics: Record<string, number | string | boolean> | Array<Record<string, number | string | boolean>>;
    step?: number;
  }): Promise<{ project: string; run: string; loggedSteps: number }> {
    const pyBin = existsSync(join(homedir(), ".local", "share", "pipx", "venvs", "trackio", "bin", "python"))
      ? join(homedir(), ".local", "share", "pipx", "venvs", "trackio", "bin", "python")
      : "python3";
    const payloadJson = JSON.stringify(params);
    const script = `
import json, os, sys
import trackio as wandb

payload = json.loads(sys.argv[1])
project = payload["project"]
run_name = payload.get("run")
config = payload.get("config") or {}
metrics = payload["metrics"]
step = payload.get("step")

run = wandb.init(project=project, name=run_name, config=config, resume="allow")
rows = metrics if isinstance(metrics, list) else [metrics]
for idx, row in enumerate(rows):
    s = step if (step is not None and len(rows) == 1) else row.get("step", step)
    clean = {k: v for k, v in row.items() if k != "step"}
    if s is not None:
        wandb.log(clean, step=int(s))
    else:
        wandb.log(clean)
wandb.finish()
print(json.dumps({"project": project, "run": getattr(run, "name", run_name or "default"), "loggedSteps": len(rows)}))
`;
    const { stdout } = await execFileAsync(pyBin, ["-c", script, payloadJson], {
      env: {
        ...process.env,
        TRACKIO_DIR: this.cfg.trackioDir,
        TRACKIO_SERVER_URL: this.cfg.serverUrl,
        TRACKIO_WRITE_TOKEN: this.cfg.writeToken,
      },
      timeout: 30000,
    });
    const lines = stdout.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // continue
      }
    }
    return {
      project: params.project,
      run: params.run ?? "default",
      loggedSteps: Array.isArray(params.metrics) ? params.metrics.length : 1,
    };
  }

  public async triggerBackup(options: { localOnly?: boolean } = {}): Promise<{
    ok: boolean;
    output: string;
    lastBackupUtc: string | null;
    gcsBucket: string | null;
  }> {
    const scriptPath = this.cfg.backupScript;
    if (!existsSync(scriptPath)) {
      throw new Error(`Trackio backup script not found at ${scriptPath}. Run web/trackio-service/setup.sh first.`);
    }
    const args = options.localOnly ? ["--local-only"] : [];
    const { stdout, stderr } = await execFileAsync(scriptPath, args, {
      env: {
        ...process.env,
        TRACKIO_DIR: this.cfg.trackioDir,
        TRACKIO_BACKUP_DIR: this.cfg.backupDir,
        TRACKIO_GCS_BUCKET: this.cfg.gcsBucket,
        ...(this.cfg.googleCredentials ? { GOOGLE_APPLICATION_CREDENTIALS: this.cfg.googleCredentials } : {}),
      },
      timeout: 120000,
    });
    const stampFile = join(this.cfg.backupDir, ".last_backup_utc");
    const lastBackupUtc = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : null;
    return {
      ok: true,
      output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
      lastBackupUtc,
      gcsBucket: this.cfg.gcsBucket || null,
    };
  }

  public async getStatus(): Promise<TrackioStatus> {
    const cfg = this.cfg;
    const stampFile = join(cfg.backupDir, ".last_backup_utc");
    const lastBackupUtc = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : null;
    const dbFiles: Array<{ name: string; sizeBytes: number; mtimeIso: string }> = [];
    if (existsSync(cfg.trackioDir)) {
      try {
        for (const entry of readdirSync(cfg.trackioDir)) {
          if (!entry.endsWith(".db")) continue;
          const st = statSync(join(cfg.trackioDir, entry));
          if (st.isFile()) {
            dbFiles.push({
              name: entry,
              sizeBytes: st.size,
              mtimeIso: st.mtime.toISOString(),
            });
          }
        }
      } catch {
        // ignore
      }
    }

    const version = await this.getVersion();
    if (!version) {
      return {
        healthy: false,
        version: null,
        serverUrl: cfg.serverUrl,
        trackioDir: cfg.trackioDir,
        backupDir: cfg.backupDir,
        gcsBucket: cfg.gcsBucket || null,
        lastBackupUtc,
        projects: [],
        projectRunCounts: {},
        dbFiles,
        error: `Trackio server unreachable at ${cfg.serverUrl}`,
      };
    }

    try {
      const projects = await this.listProjects();
      const projectRunCounts: Record<string, number> = {};
      await Promise.all(
        projects.slice(0, 20).map(async (proj) => {
          try {
            const runs = await this.listRuns(proj);
            projectRunCounts[proj] = runs.length;
          } catch {
            projectRunCounts[proj] = 0;
          }
        }),
      );
      return {
        healthy: true,
        version,
        serverUrl: cfg.serverUrl,
        trackioDir: cfg.trackioDir,
        backupDir: cfg.backupDir,
        gcsBucket: cfg.gcsBucket || null,
        lastBackupUtc,
        projects,
        projectRunCounts,
        dbFiles,
      };
    } catch (err) {
      return {
        healthy: false,
        version,
        serverUrl: cfg.serverUrl,
        trackioDir: cfg.trackioDir,
        backupDir: cfg.backupDir,
        gcsBucket: cfg.gcsBucket || null,
        lastBackupUtc,
        projects: [],
        projectRunCounts: {},
        dbFiles,
        error: String((err as Error)?.message ?? err),
      };
    }
  }

  public async getPlotSeries(params: {
    project?: string;
    runs?: string[];
    metrics?: string[];
    xAxis?: string;
    maxPoints?: number;
  }): Promise<PlotSeriesPayload> {
    const cacheKey = JSON.stringify({
      p: (params.project ?? "").trim().slice(0, 80),
      r: params.runs ?? null,
      m: params.metrics ?? null,
      x: params.xAxis ?? "step",
      n: params.maxPoints ?? 500,
    });
    const now = Date.now();
    const cached = this.seriesCache.get(cacheKey);
    if (cached && now - cached.ts < 1500) {
      return cached.data;
    }
    const inflight = this.seriesInFlight.get(cacheKey);
    if (inflight) return inflight;

    const promise = this._fetchPlotSeriesUncached(params)
      .then((data) => {
        this.seriesCache.set(cacheKey, { ts: Date.now(), data });
        return data;
      })
      .catch((err) => {
        if (cached) return cached.data;
        throw err;
      })
      .finally(() => {
        this.seriesInFlight.delete(cacheKey);
      });
    this.seriesInFlight.set(cacheKey, promise);
    return promise;
  }

  private async _fetchPlotSeriesUncached(params: {
    project?: string;
    runs?: string[];
    metrics?: string[];
    xAxis?: string;
    maxPoints?: number;
  }): Promise<PlotSeriesPayload> {
    const allProjects = await this.listProjects().catch(() => []);
    const reqProj = (params.project ?? "").trim();
    const project =
      allProjects.find((p) => p === reqProj) ??
      allProjects.find((p) => p.toLowerCase() === reqProj.toLowerCase()) ??
      allProjects[0] ??
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
        fetchedAt: new Date().toISOString(),
      };
    }

    const [runRecords, runConfigs] = await Promise.all([
      this.listRuns(project),
      this.getRunConfigs(project),
    ]);
    // Newest runs first (Trackio returns runs in creation order)
    const allRuns = [...runRecords].reverse().map((r) => r.name);
    const wantedRuns =
      params.runs && params.runs.length > 0
        ? allRuns.filter((r) => params.runs!.includes(r))
        : allRuns.slice(0, 24);
    const selectedRuns = wantedRuns.length > 0 ? wantedRuns : allRuns.slice(0, 24);

    const batch = selectedRuns.length > 0 ? await this.getLogsBatch(project, selectedRuns) : [];
    const xAxis = params.xAxis || "step";
    const maxPoints = Math.max(50, Math.min(2000, params.maxPoints ?? 500));

    const metricSet = new Set<string>();
    const reserved = new Set(["step", "time", "timestamp", "_step", "_timestamp", "run"]);

    const rawSeries: RunSeries[] = batch.map((entry, idx) => {
      const runName = entry.run;
      const colorIndex = Math.max(0, allRuns.indexOf(runName));
      const logs = Array.isArray(entry.logs) ? entry.logs : [];
      const metricsMap: Record<string, SeriesPoint[]> = {};
      const latest: Record<string, number> = {};
      const min: Record<string, number> = {};
      const max: Record<string, number> = {};

      for (let i = 0; i < logs.length; i++) {
        const row = logs[i];
        if (!row || typeof row !== "object") continue;
        const stepVal =
          typeof row[xAxis] === "number" && Number.isFinite(row[xAxis] as number)
            ? (row[xAxis] as number)
            : typeof row.step === "number" && Number.isFinite(row.step)
              ? row.step
              : i;
        const timeVal = (row.time ?? row.timestamp ?? null) as string | number | null;

        for (const [key, val] of Object.entries(row)) {
          if (reserved.has(key)) continue;
          if (typeof val !== "number" || !Number.isFinite(val)) continue;
          metricSet.add(key);
          if (!metricsMap[key]) metricsMap[key] = [];
          metricsMap[key].push({ step: stepVal, time: timeVal, value: val });
          latest[key] = val;
          min[key] = min[key] === undefined ? val : Math.min(min[key], val);
          max[key] = max[key] === undefined ? val : Math.max(max[key], val);
        }
      }

      for (const [key, pts] of Object.entries(metricsMap)) {
        pts.sort((a, b) => a.step - b.step);
        if (pts.length > maxPoints) {
          const stride = (pts.length - 1) / (maxPoints - 1);
          const sampled: SeriesPoint[] = [];
          for (let j = 0; j < maxPoints - 1; j++) {
            sampled.push(pts[Math.floor(j * stride)]);
          }
          sampled.push(pts[pts.length - 1]);
          metricsMap[key] = sampled;
        }
      }

      return {
        run: runName,
        colorIndex: colorIndex >= 0 ? colorIndex : idx,
        config: runConfigs[runName] ?? {},
        metrics: metricsMap,
        latest,
        min,
        max,
      };
    });

    const availableMetrics = sortMetricsByPriority([...metricSet]);
    let selectedMetrics = availableMetrics;
    if (params.metrics && params.metrics.length > 0) {
      const requested = params.metrics.map((m) => m.trim()).filter(Boolean);
      const matched = availableMetrics.filter((m) =>
        requested.some((req) => matchesMetricPattern(m, req)),
      );
      if (matched.length > 0) selectedMetrics = matched;
    }

    return {
      project,
      allProjects,
      allRuns,
      selectedRuns,
      availableMetrics,
      selectedMetrics,
      xAxis,
      series: rawSeries,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export const trackioClient = new TrackioClient();
