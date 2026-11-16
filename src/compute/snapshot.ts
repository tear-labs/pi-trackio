import { loadComputeConfig, realRunner, redact, report, type ComputeConfig } from "./config.ts";
import { collectModal } from "./modal.ts";
import { collectGcp } from "./gcp.ts";
import { collectSfcompute, resolveSfToken } from "./sfcompute.ts";
import { collectVast, resolveVastKey } from "./vast.ts";
import { collectProjectData, linkJobs, type ProjectData } from "./links.ts";
import type { ComputeJob, ComputeSnapshot, ProviderId, ProviderReport, Runner } from "./types.ts";
let cache: ComputeSnapshot | null = null;
let inFlight: Promise<ComputeSnapshot> | null = null;
const ids: ProviderId[] = ["modal", "gcp", "sfcompute", "vast"];
function failure(id: ProviderId, now: number): ProviderReport { return { ...report(id, now), state: "error", message: "Compute collection failed or timed out" }; }
export function countSilentJobs(jobs: ComputeJob[]): number {
  return jobs.filter(j => j.status === "running" && j.trackio && ["stale", "old", "none"].includes(j.trackio.freshness)).length;
}
function snapshot(providers: ProviderReport[], now: number, refreshSeconds: number): ComputeSnapshot {
  const jobs = providers.flatMap(p => p.jobs);
  return { checkedAt: new Date(now).toISOString(), refreshSeconds, stale: false, totals: { silent: 0, running: jobs.filter(j => j.status === "running").length, jobs: jobs.length, providers: ids.length, providersOk: providers.filter(p => p.state === "ok").length }, providers, logging: [] };
}
export function __resetComputeCache(): void { cache = null; inFlight = null; }
export async function collectComputeSnapshot(options: { force?: boolean } = {}, deps?: {
  providers?: Array<(cfg: ComputeConfig, runner: Runner, now: number) => Promise<ProviderReport>>;
  projectData?: (now: number) => Promise<ProjectData[]>;
}): Promise<ComputeSnapshot> {
  const now = Date.now();
  try {
    const cfg = loadComputeConfig();
    const token = resolveSfToken(cfg);
    const vastKey = resolveVastKey(cfg);
    const sanitize = (s: ComputeSnapshot) => {
      const scrub = (v: ComputeSnapshot) => redact(redact(v, token), encodeURIComponent(token));
      const once = token ? scrub(s) : s;
      return vastKey ? redact(once, vastKey) : once;
    };
    const refreshSeconds = Math.max(10, Math.min(300, Number(cfg.refreshSeconds) || 20));
    if (cache && options.force && now - Date.parse(cache.checkedAt) < 5000) return sanitize({ ...cache, stale: true });
    if (cache && !options.force && now - Date.parse(cache.checkedAt) < refreshSeconds * 1000) return sanitize({ ...cache, stale: false });
    if (inFlight) return sanitize(cache ? { ...cache, stale: true } : await inFlight);
    inFlight = (async () => {
      const providers = ids.map(id => failure(id, now));
      let data: Awaited<ReturnType<typeof collectProjectData>> = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = Promise.all([
          ...(deps?.providers ?? [collectModal, collectGcp, collectSfcompute, collectVast]).map(async (fn, i) => { try { providers[i] = await fn(cfg, realRunner, now); } catch { providers[i] = failure(ids[i], now); } }),
          (deps?.projectData ?? collectProjectData)(now).then(d => { data = d; }).catch(() => {}),
        ]);
        await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, 13000); })]);
        // Copy reports so late completions cannot mutate the published snapshot.
        const result = snapshot(providers.slice(), now, refreshSeconds);
        linkJobs(result.providers.flatMap(p => p.jobs), data, cfg);
        result.totals.silent = countSilentJobs(result.providers.flatMap(p => p.jobs));
        result.logging = data.flatMap(p => p.logging ? [p.logging] : []).sort((a, b) => a.ageSeconds - b.ageSeconds);
        cache = sanitize(result); return cache;
      } catch { return cache = sanitize(snapshot(ids.map(id => failure(id, now)), now, refreshSeconds)); }
      finally { clearTimeout(timer); }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  } catch { return snapshot(ids.map(id => failure(id, now)), now, 20); }
}
export function computeSummaryMarkdown(s: ComputeSnapshot, open = true): string {
  const t = s.totals;
  const lines = [`⚡ Active compute — ${t.running} running / ${t.jobs} jobs · providers ok ${t.providersOk}/${t.providers}${t.silent > 0 ? ` · ${t.silent} silent` : ""}`];
  for (const p of s.providers) {
    const stats = p.stats?.length ? ` · ${p.stats.map(x => `${x.label} ${x.value}`).join(" · ")}` : "";
    lines.push(`- **${p.label}** (${p.state}): ${p.state === "ok" ? `${p.jobs.filter(j => j.status === "running").length} running${stats}${p.message ? ` — ${p.message}` : ""}` : p.message || p.state}`);
    for (const j of p.jobs) { if (lines.length >= 35) break; const m = Math.floor((j.uptimeSeconds || 0)/60); const util = j.utilization?.gpu != null ? ` · gpu ${Math.round(j.utilization.gpu)}%` : ""; lines.push(`  • ${j.name} · ${j.status}${util} · up ${j.uptimeSeconds !== null && j.uptimeSeconds < 60 ? "just started" : m < 60 ? `${m}m` : `${Math.floor(m/60)}h ${String(m%60).padStart(2, "0")}m`} · ${j.accelerator || "—"} · ${j.trackio ? `→ ${j.trackio.project} (${j.trackio.freshness})` : j.suggestion ? `? ${j.suggestion.project} (${j.suggestion.score.toFixed(2)})` : "—"}`); }
  }
  const age = (seconds: number) => seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m` : `${Math.floor(seconds/3600)}h`;
  const fresh = s.logging.filter(p => p.ageSeconds <= 3600);
  const quieter = s.logging.filter(p => p.ageSeconds > 3600);
  lines.push(`**Logging now:** ${fresh.map(p => `${p.project} (${age(p.ageSeconds)})`).join(" · ") || "—"}${quieter.length ? ` + ${quieter.length} quieter (oldest ${age(Math.max(...quieter.map(p => p.ageSeconds)))})` : ""}`);
  if (open) lines.push("[⚡ Open compute dashboard](/__trackio/compute)");
  return lines.join("\n");
}
