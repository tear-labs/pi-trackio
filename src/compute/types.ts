export type ProviderId = "modal" | "gcp" | "sfcompute" | "vast";
export type StatTone = "ok" | "warn" | "bad" | "muted";
export interface ProviderStat { label: string; value: string; tone?: StatTone }
export type ProviderState = "ok" | "checking" | "auth_required" | "not_configured" | "error";
export type Freshness = "live" | "recent" | "stale" | "old" | "none";
export type Runner = (cmd: string, args: string[], opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface TrackioLink { project: string; match: "override" | "app_id" | "name"; score: number; runs: string[]; lastMetricAt: string | null; lastMetricAgeSeconds: number | null; freshness: Freshness }
export interface ComputeJob {
  id: string; provider: ProviderId; name: string; kind: "app" | "container" | "vm" | "tpu" | "instance";
  status: "running" | "pending" | "unknown"; startedAt: string | null; uptimeSeconds: number | null;
  suggestion: { project: string; score: number } | null;
  replicas: number | null; accelerator: string | null; region: string | null; trackio: TrackioLink | null; url: string | null; detail: string | null;
  utilization?: { gpu: number | null; cpu: number | null } | null;
}
export interface ProviderReport { id: ProviderId; label: string; state: ProviderState; message: string | null; checkedAt: string; latencyMs: number | null; jobs: ComputeJob[]; stats?: ProviderStat[] }
export interface LoggingProject { project: string; lastMetricAt: string; ageSeconds: number; runs: number; freshness: Freshness }
export interface ComputeSnapshot { checkedAt: string; refreshSeconds: number; stale: boolean; totals: { running: number; silent: number; jobs: number; providers: number; providersOk: number }; providers: ProviderReport[]; logging: LoggingProject[] }
