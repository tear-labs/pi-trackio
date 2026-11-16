import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ComputeJob, ProviderId, ProviderReport, Runner } from "./types.ts";
export interface ComputeConfig {
  refreshSeconds?: number;
  modal?: { cli?: string; environments?: string[] };
  gcp?: { cli?: string; projects?: string[]; zones?: string[]; includeTpus?: boolean };
  sfcompute?: { token?: string; tokenFile?: string; baseUrl?: string; instancesPath?: string; workspace?: string };
  vast?: { token?: string; tokenFile?: string; baseUrl?: string; instancesPath?: string };
  linkOverrides?: Record<string, { project: string; runs?: string[] }>;
}
export function redact<T>(value: T, token: string): T {
  if (!token) return value;
  if (typeof value === "string") return value.split(token).join("[redacted]") as T;
  if (Array.isArray(value)) return value.map(item => redact(item, token)) as T;
  if (value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, token)])) as T;
  }
  return value;
}
export const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
export function loadComputeConfig(): ComputeConfig {
  try {
    const c = JSON.parse(readFileSync(process.env.PI_TRACKIO_COMPUTE_CONFIG || join(homedir(), ".config/trackio-compute.json"), "utf8"));
    if (!c || typeof c !== "object" || Array.isArray(c)) return {};
    for (const key of ["modal", "gcp", "sfcompute", "vast", "linkOverrides"]) if (c[key] != null && (typeof c[key] !== "object" || Array.isArray(c[key]))) return {};
    return c;
  } catch { return {}; }
}
const exec = promisify(execFile);
export const realRunner: Runner = async (cmd, args, opts) => {
  try { const r = await exec(cmd, args, { timeout: opts.timeoutMs, env: opts.env, maxBuffer: 4 * 1024 * 1024 }); return { code: 0, stdout: r.stdout, stderr: r.stderr }; }
  catch (e) { const r = e as { code?: number | string; stdout?: string; stderr?: string; message?: string }; return { code: typeof r.code === "number" ? r.code : -1, stdout: r.stdout || "", stderr: r.code === "ENOENT" ? "ENOENT" : r.stderr || r.message || "Command failed" }; }
};
export function gcloudCli(cfg: ComputeConfig): string {
  if (cfg.gcp?.cli) return cfg.gcp.cli;
  for (const dir of (process.env.PATH || "").split(":")) { const p = join(dir, "gcloud"); try { accessSync(p, constants.X_OK); return p; } catch {} }
  return "gcloud";
}
export function modalCli(cfg: ComputeConfig): string {
  if (cfg.modal?.cli) return cfg.modal.cli;
  for (const dir of (process.env.PATH || "").split(":")) { const p = join(dir, "modal"); try { accessSync(p, constants.X_OK); return p; } catch {} }
  return join(homedir(), ".local/bin/modal");
}
export function report(id: ProviderId, now: number): ProviderReport { return { id, label: { modal: "Modal", gcp: "Google Cloud", sfcompute: "SF Compute", vast: "Vast.ai" }[id], state: "ok", message: null, checkedAt: new Date(now).toISOString(), latencyMs: null, jobs: [], stats: [] }; }
export function job(id: string, provider: ProviderId, name: string, started: unknown, now: number): ComputeJob {
  const ms = typeof started === "string" ? Date.parse(started.replace(" ", "T")) : NaN;
  return { id, provider, name, kind: "instance", status: "unknown", startedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null, uptimeSeconds: Number.isFinite(ms) ? Math.max(0, (now-ms)/1000) : null, replicas: null, accelerator: null, region: null, trackio: null, suggestion: null, url: null, detail: null };
}
export async function safeRun(runner: Runner, cmd: string, args: string[], timeoutMs: number) {
  try { return await runner(cmd, args, { timeoutMs }); } catch (e) { const err = e as { code?: string; message?: string }; return { code: -1, stdout: "", stderr: err.code === "ENOENT" ? "ENOENT" : err.message || "Command failed" }; }
}
export type Row = Record<string, unknown>;
export function rows(text: string): Row[] { const v: unknown = JSON.parse(text); return Array.isArray(v) ? v : []; }
export const text = (v: unknown): string => typeof v === "string" ? v : "";
