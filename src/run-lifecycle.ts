import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Target {
  run_id: unknown;
  run_name: string;
  path?: string;
  app_id?: string;
  commit?: string;
  reported_status?: string;
}

export interface JobStatus {
  run_id: unknown;
  run_name: string;
  status: string;
  source: string;
  checkedAt: string;
  detail?: string;
  app_id?: string;
}

export const JOB_LABELS: Record<string, string> = {
  running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled",
  paused: "Paused", stopped: "Stopped (outcome unknown)", idle: "Active app (no worker)",
  checking: "Checking", unknown: "Unknown",
};

export function lifecycleTarget(row: Record<string, unknown>): Target {
  let config: Record<string, any> = {};
  try { config = JSON.parse(String(row.config || "{}")); } catch { /* unknown */ }
  const target: Target = { run_id: row.run_id, run_name: String(row.run_name),
    reported_status: typeof config.status === "string" ? config.status : undefined };
  const plan = config.plan;
  if (plan?.executor === "modal" && plan.run_id === row.run_name &&
      /^[A-Za-z0-9_.-]+$/.test(plan.run_id) && /^v\d+_[A-Za-z0-9_]+$/.test(plan.experiment)) {
    target.path = `${plan.experiment}/${plan.run_id}/run.json`;
    target.commit = config.provenance?.commit;
  }
  const app = config.submission?.app_id || config.backend_info?.app_id;
  if (typeof app === "string" && /^ap-[A-Za-z0-9]+$/.test(app)) target.app_id = app;
  return target;
}

const cache = new Map<string, { expires: number; runs: JobStatus[] }>();
const pending = new Map<string, Promise<JobStatus[]>>();

export async function getJobStatuses(project: string, rows: Array<Record<string, unknown>>): Promise<JobStatus[]> {
  const targets = rows.map(lifecycleTarget);
  let options;
  try {
    options = JSON.parse(readFileSync(process.env.PI_TRACKIO_STATUS_CONFIG || join(homedir(), ".config/trackio-status.json"), "utf8")).modal;
  } catch { /* No provider is implicitly enabled. */ }
  const key = JSON.stringify({ project, targets, options });
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.runs;
  const checking = () => targets.map(t => ({ run_id: t.run_id, run_name: t.run_name,
    status: "checking", source: "checking", checkedAt: new Date().toISOString(),
    detail: "Checking the worker record and provider; log activity is not used to infer job state." }));
  const running = pending.get(key);
  if (running) return checking();
  const task = (async () => {
    let runs: JobStatus[];
    if (!options?.python || !options?.cli || !options?.runsVolume) {
      runs = targets.map(t => ({ ...t, status: "unknown", source: "unavailable", checkedAt: new Date().toISOString(), detail: "Provider status adapter is not configured." }));
    } else {
      const script = fileURLToPath(new URL("../tools/run-lifecycle.py", import.meta.url));
      runs = await new Promise<JobStatus[]>((resolve) => {
        const child = execFile(options.python, [script], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
          try {
            if (error) throw error;
            resolve(JSON.parse(stdout).runs);
          } catch {
            resolve(targets.map(t => ({ ...t, status: "unknown", source: "unavailable", checkedAt: new Date().toISOString(), detail: "Status check failed; no inference made from old activity." })));
          }
        });
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify({ modal: options, targets }));
      });
    }
    cache.set(key, { expires: Date.now() + 30000, runs });
    return runs;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  // Keep chart loading independent of provider latency. The next UI poll picks
  // up the completed check. Expired Running results are never silently reused.
  return checking();
}
