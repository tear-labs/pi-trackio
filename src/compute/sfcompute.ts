import { readFileSync } from "node:fs";
import { expandHome, job, redact, report, text, type ComputeConfig, type Row } from "./config.ts";
import type { ProviderReport, Runner } from "./types.ts";
const paths = new Map<string, string>();
export function resolveSfToken(cfg: ComputeConfig): string {
  const c = cfg.sfcompute || {};
  const token = c.token || process.env.SFCOMPUTE_API_TOKEN || "";
  if (token) return token;
  try { return readFileSync(expandHome(c.tokenFile || "~/.config/sfcompute.token"), "utf8").trim(); } catch { return ""; }
}
export async function collectSfcompute(cfg: ComputeConfig, _runner: Runner, now: number, request: typeof fetch = fetch): Promise<ProviderReport> {
  const r = report("sfcompute", now), begin = Date.now();
  let token = "";
  try {
    const c = cfg.sfcompute || {};
    token = resolveSfToken(cfg);
    if (!token) { r.state = "not_configured"; r.message = 'SF Compute is not linked: run "sf login && sf tokens create --name pi-compute" and set SFCOMPUTE_API_TOKEN (or ~/.config/sfcompute.token)'; }
    else {
      const base = (c.baseUrl || "https://api.sfcompute.com").replace(/\/+$/, "");
      const key = JSON.stringify([base, c.instancesPath || "", c.workspace || ""]);
      let path = paths.get(key) || c.instancesPath || "/preview/v2/instances";
      const get = (p: string) => request(`${base}${p}${c.workspace ? `?workspace=${encodeURIComponent(c.workspace)}` : ""}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      let res = await get(path);
      if (res.status === 404 && path !== "/instances") { await res.body?.cancel(); path = "/instances"; res = await get(path); }
      if (res.status === 401 || res.status === 403) { r.state = "auth_required"; r.message = "SF Compute token was rejected; check token permissions and configuration"; await res.body?.cancel(); }
      else if (!res.ok) { r.state = "error"; r.message = `SF Compute request failed (HTTP ${res.status})`; await res.body?.cancel(); }
      else {
        paths.set(key, path);
        const body = await res.json() as Row | Row[];
        const data = Array.isArray(body) ? body : body.data || body.items || body.instances;
        if (!Array.isArray(data)) throw new Error("Invalid SF Compute instance response");
        for (const a of data as Row[]) {
          if (a.status !== "running" && a.status !== "awaiting_allocation") continue;
          const j = job(text(a.id || a.name), "sfcompute", text(a.name || a.id), a.created_at || a.createdAt, now);
          Object.assign(j, { status: a.status === "running" ? "running" : "pending", region: text(a.pool_id || a.pool) || null, accelerator: text(a.sku_id || a.instance_sku || a.sku) || null }); r.jobs.push(j);
        }
      }
    }
  } catch { r.state = "error"; r.message = "SF Compute request failed"; }
  // Provider-controlled fields must not accidentally disclose the credential either.
  r.latencyMs = Date.now() - begin;
  return redact(r, token);
}
