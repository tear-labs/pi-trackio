import { trackioClient } from "../client.ts";
import type { ComputeConfig } from "./config.ts";
import type { ComputeJob, Freshness, LoggingProject } from "./types.ts";
export const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function fuzzyProject(jobName: string, projects: string[]): { project: string; score: number } | null {
  const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 || /^v\d+$/.test(t)));
  const versions = (s: string) => [...s.matchAll(/v(\d+)/gi)].at(-1)?.[1];
  const jt = tokens(jobName), jv = versions(jobName); if (!jt.size) return null;
  const candidates: { project: string; score: number }[] = [];
  for (const project of projects) {
    const pv = versions(project);
    if (jv !== undefined && pv !== undefined && jv !== pv) continue;
    const pt = tokens(project), intersection = [...jt].filter(t => pt.has(t)).length;
    candidates.push({ project, score: intersection / new Set([...jt, ...pt]).size });
  }
  candidates.sort((a, b) => b.score - a.score);
  const [best, second] = candidates;
  if (!best || (second && best.score - second.score < 0.01)) return null;
  return best;
}
export function matchProject(jobName: string, projects: string[]): { project: string; score: number } | null {
  const literal = projects.find(p => p.trim().toLowerCase() === jobName.trim().toLowerCase());
  if (literal) return { project: literal, score: 1 };
  const exact = projects.filter(p => normalizeName(p) === normalizeName(jobName));
  if (exact.length) return exact.length === 1 ? { project: exact[0], score: 1 } : null;
  const best = fuzzyProject(jobName, projects);
  return best && best.score >= 0.6 ? best : null;
}
export function suggestProject(jobName: string, projects: string[]): { project: string; score: number } | null {
  if (matchProject(jobName, projects)) return null;
  const best = fuzzyProject(jobName, projects);
  if (best && best.score >= 0.34 && best.score < 0.6) return best;
  const norm = normalizeName(jobName);
  const candidates = projects.flatMap(project => {
    const projectNorm = normalizeName(project);
    const minLen = Math.min(norm.length, projectNorm.length), maxLen = Math.max(norm.length, projectNorm.length);
    return minLen >= 6 && (projectNorm.startsWith(norm) || projectNorm.endsWith(norm) || norm.startsWith(projectNorm) || norm.endsWith(projectNorm))
      ? [{ project, ratio: minLen / maxLen }] : [];
  }).sort((a, b) => b.ratio - a.ratio);
  const [first, second] = candidates;
  if (!first || (second && first.ratio - second.ratio < 0.01)) return null;
  return { project: first.project, score: Math.min(0.59, Math.max(0.34, first.ratio)) };
}
export const freshness = (age: number | null): Freshness => age === null ? "none" : age <= 120 ? "live" : age <= 900 ? "recent" : age <= 3600 ? "stale" : "old";
export interface ProjectData { project: string; configs: Record<string, Record<string, unknown>>; logging: LoggingProject | null }
export function linkJobs(jobs: ComputeJob[], data: ProjectData[], cfg: ComputeConfig): void {
  const apps = new Map<string, { project: string; runs: string[] }>();
  for (const p of data) for (const [run, config] of Object.entries(p.configs)) for (const key of ["submission", "backend_info"]) {
    const value = config[key]; const id = value && typeof value === "object" ? (value as Record<string, unknown>).app_id : null;
    if (typeof id !== "string" || !id.startsWith("ap-")) continue;
    const entry = apps.get(id); if (entry && entry.project === p.project) { if (!entry.runs.includes(run)) entry.runs.push(run); } else if (!entry) apps.set(id, { project: p.project, runs: [run] });
  }
  for (const j of jobs) {
    const override = Object.entries(cfg.linkOverrides || {}).find(([key]) => key.toLowerCase() === j.id.toLowerCase() || key.toLowerCase() === j.name.toLowerCase())?.[1];
    const app = apps.get(j.id), name = matchProject(j.name, data.map(p => p.project));
    const selected = override || app || name;
    j.suggestion = null;
    if (!selected) {
      if (!j.trackio) j.suggestion = suggestProject(j.name, data.map(p => p.project));
      continue;
    }
    const log = data.find(p => p.project === selected.project)?.logging;
    const runs = override ? override.runs || [] : app?.runs || [];
    j.trackio = { project: selected.project, match: override ? "override" : app ? "app_id" : "name", score: override || app ? 1 : name!.score, runs, lastMetricAt: log?.lastMetricAt || null, lastMetricAgeSeconds: log?.ageSeconds ?? null, freshness: log?.freshness || "none" };
    j.url = `/__trackio/app/?project=${encodeURIComponent(selected.project)}` + (runs.length ? `&runs=${encodeURIComponent(runs.join(","))}` : "");
  }
}
export async function collectProjectData(now: number): Promise<ProjectData[]> {
  const projects = (await trackioClient.listProjects()).slice(0, 25);
  const results = await Promise.allSettled(projects.map(async project => {
    const [configs, result] = await Promise.all([trackioClient.getRunConfigs(project), trackioClient.querySql(project, "SELECT max(ts) AS last FROM (SELECT timestamp AS ts FROM metrics UNION ALL SELECT timestamp AS ts FROM system_metrics)").catch(() => null)]);
    const rows = Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] } | null)?.rows;
    const last = rows?.[0]?.last; const ms = typeof last === "string" ? Date.parse(last) : NaN;
    const ageSeconds = Math.max(0, (now - ms) / 1000);
    const logging: LoggingProject | null = Number.isFinite(ms) ? { project, lastMetricAt: new Date(ms).toISOString(), ageSeconds, runs: Object.keys(configs).length, freshness: freshness(ageSeconds) } : null;
    return { project, configs, logging };
  }));
  return results.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
}
