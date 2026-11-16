import { readFileSync } from "node:fs";
import { expandHome, job, redact, report, text, type ComputeConfig, type Row } from "./config.ts";
import type { ComputeJob, ProviderReport } from "./types.ts";

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function resolveVastKey(cfg: ComputeConfig): string {
  const c = cfg.vast || {};
  if (c.token) return c.token;
  for (const name of ["VAST_AI_API_KEY", "VAST_API_KEY"]) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  for (const p of [c.tokenFile || "~/.config/vastai/vast_api_key", "~/.vast_api_key"]) {
    try {
      const t = readFileSync(expandHome(p), "utf8").trim();
      if (t) return t;
    } catch {}
  }
  return "";
}

function stateOf(a: Row): ComputeJob["status"] {
  const s = `${text(a.actual_status) || text(a.cur_state)}`.toLowerCase();
  if (/^running$|^running /.test(s)) return "running";
  if (/loading|creating|queued|scheduling|provision|starting/.test(s)) return "pending";
  return "unknown";
}

export async function collectVast(
  cfg: ComputeConfig,
  _runner: unknown,
  now: number,
  request: typeof fetch = fetch,
): Promise<ProviderReport> {
  const r = report("vast", now);
  const begin = Date.now();
  let token = "";
  try {
    token = resolveVastKey(cfg);
    if (!token) {
      r.state = "not_configured";
      r.message = 'Vast.ai is not linked: set VAST_AI_API_KEY (or write ~/.config/vastai/vast_api_key)';
    } else {
      const c = cfg.vast || {};
      const base = (c.baseUrl || "https://console.vast.ai/api/v0").replace(/\/+$/, "");
      const instancesPath = c.instancesPath || "/instances/?owner=me&limit=200";
      const get = (path: string) =>
        request(`${base}${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(9000),
        });
      const [userRes, instRes] = await Promise.all([get("/users/current/"), get(instancesPath)]);

      if (userRes.status === 401 || userRes.status === 403 || instRes.status === 401 || instRes.status === 403) {
        r.state = "auth_required";
        r.message = "Vast.ai API key was rejected; check VAST_AI_API_KEY / ~/.config/vastai/vast_api_key";
        await userRes.body?.cancel();
        await instRes.body?.cancel();
      } else if (!userRes.ok) {
        r.state = "error";
        r.message = `Vast.ai account request failed (HTTP ${userRes.status})`;
        await userRes.body?.cancel();
        await instRes.body?.cancel();
      } else {
        const user = (await userRes.json()) as Row;
        const body = instRes.ok ? ((await instRes.json()) as Row) : {};
        if (!instRes.ok) r.message = `Instances request failed (HTTP ${instRes.status}); showing account only`;
        const list = Array.isArray(body) ? (body as Row[]) : Array.isArray(body.instances) ? (body.instances as Row[]) : [];

        for (const a of list) {
          const status = stateOf(a);
          if (status === "unknown") continue;
          const gpus = num(a.num_gpus) ?? 1;
          const gpuName = text(a.gpu_name) || "GPU";
          const label = text(a.label);
          const j = job(
            String(a.id),
            "vast",
            label || `${gpuName} ×${gpus}`,
            num(a.start_date) !== null ? new Date((num(a.start_date) as number) * 1000).toISOString() : null,
            now,
          );
          const uptimeMins = num(a.uptime_mins);
          const diskUsage = num(a.disk_usage);
          const diskSpace = num(a.disk_space);
          Object.assign(j, {
            status,
            accelerator: `${gpus}× ${gpuName}`,
            region: text(a.geolocation) || text(a.country_code) || null,
            replicas: gpus,
            utilization: { gpu: num(a.gpu_util), cpu: num(a.cpu_util) },
            detail: [
              num(a.dph_total) !== null ? `$${(num(a.dph_total) as number).toFixed(2)}/hr` : null,
              num(a.gpu_temp) !== null ? `${Math.round(num(a.gpu_temp) as number)}°C` : null,
              diskUsage !== null && diskSpace !== null ? `${Math.round(diskUsage)}/${Math.round(diskSpace)} GB disk` : null,
              text(a.ssh_host) && num(a.ssh_port) !== null ? `ssh ${text(a.ssh_host)}:${num(a.ssh_port)}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
            url: `https://cloud.vast.ai/instances/`,
          });
          if (uptimeMins !== null && uptimeMins > 0) j.uptimeSeconds = uptimeMins * 60;
          r.jobs.push(j);
        }

        const running = list.filter(a => stateOf(a) === "running");
        const burn = running.reduce((sum, a) => sum + (num(a.dph_total) ?? 0), 0);
        const credit = num(user.credit);
        const gpuHours = running.reduce((sum, a) => sum + (num(a.num_gpus) ?? 0), 0);
        const weighted = running.reduce((sum, a) => sum + (num(a.gpu_util) ?? 0) * (num(a.num_gpus) ?? 0), 0);
        const avgUtil = gpuHours > 0 ? weighted / gpuHours : null;
        const runwayHours = credit !== null && burn > 0 ? credit / burn : null;
        const idle = running.filter(a => (num(a.gpu_util) ?? 0) < 5);
        const idleBurn = idle.reduce((sum, a) => sum + (num(a.dph_total) ?? 0), 0);

        r.stats = [
          { label: "credit", value: credit !== null ? `$${credit.toFixed(2)}` : "—", tone: credit !== null && credit < 10 ? "bad" : "ok" },
          { label: "burn", value: `$${burn.toFixed(2)}/hr`, tone: burn > 0 ? "warn" : "muted" },
          {
            label: "runway",
            value: runwayHours === null ? "—" : runwayHours >= 48 ? `${(runwayHours / 24).toFixed(1)}d` : `${runwayHours.toFixed(1)}h`,
            tone: runwayHours !== null && runwayHours < 12 ? "bad" : runwayHours !== null && runwayHours < 48 ? "warn" : "ok",
          },
          { label: "gpus", value: `${gpuHours}`, tone: "muted" },
          { label: "util", value: avgUtil !== null && gpuHours > 0 ? `${Math.round(avgUtil)}%` : "—", tone: avgUtil !== null && avgUtil < 20 ? "warn" : "ok" },
          { label: "idle", value: idle.length ? `${idle.length} · $${idleBurn.toFixed(2)}/hr` : "0", tone: idle.length ? "bad" : "ok" },
        ];
        const warnings: string[] = [];
        if (idle.length) warnings.push(`${idle.length} instance${idle.length === 1 ? "" : "s"} idle (GPU <5%) while billing $${idleBurn.toFixed(2)}/hr`);
        if (burn > 0 && runwayHours !== null && runwayHours < 12) warnings.push(`credit runs out in ${runwayHours.toFixed(1)}h at the current burn rate`);
        if (warnings.length) r.message = warnings.join(" · ");
      }
    }
  } catch {
    r.state = "error";
    r.message = "Vast.ai request failed";
  }
  r.latencyMs = Date.now() - begin;
  return redact(r, token);
}
