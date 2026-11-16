import { gcloudCli, job, report, rows, safeRun, text, type ComputeConfig, type Row } from "./config.ts";
import type { ProviderReport, Runner } from "./types.ts";
const tail = (v: unknown) => text(v).split("/").pop() || "";
const authPattern = /invalid authentication credentials|Expected OAuth 2 access token|reauth|Reauthentication failed|invalid_grant|Please run:.*gcloud auth login|There was a problem refreshing your current auth tokens/i;
const authMessage = (projects: string[]) => `Google Cloud credentials need re-authentication: run "gcloud auth login" (projects: ${projects.join(", ") || "default project discovery"})`;
function accelerator(a: Row, machine: string): string | null {
  if (Array.isArray(a.guestAccelerators) && a.guestAccelerators.length) return a.guestAccelerators.map((g: Row) => {
    const t = tail(g.acceleratorType).replace(/^nvidia-(tesla-)?/, "").toUpperCase();
    return `${g.acceleratorCount}× ${t}`;
  }).join(" · ");
  const families: [RegExp, string, number?][] = [
    [/^a2-highgpu-(1|2|4|8)g$/, "A100 40GB"], [/^a2-ultragpu-(1|2|4|8)g$/, "A100 80GB"],
    [/^a3-highgpu-8g$/, "H100", 8], [/^a3-ultragpu-8g$/, "H200", 8],
    [/^g2-standard-(4|8|12|16)$/, "L4", 1], [/^g2-standard-(24|32)$/, "L4", 2], [/^g2-standard-(48|96)$/, "L4", 4],
  ];
  for (const [pattern, label, count] of families) { const match = machine.match(pattern); if (match) return `~${count ?? Number(match[1])}× ${label}`; }
  return null;
}
export async function collectGcp(cfg: ComputeConfig, runner: Runner, now: number): Promise<ProviderReport> {
  const r = report("gcp", now), begin = Date.now();
  try {
    let projects = cfg.gcp?.projects || [];
    let discovery: Awaited<ReturnType<typeof safeRun>> | null = null;
    if (!projects.length) {
      discovery = await safeRun(runner, gcloudCli(cfg), ["config", "get-value", "project"], 6000);
      const value = discovery.stdout.trim(); projects = discovery.code === 0 && value && value !== "(unset)" ? [value] : [];
    }
    if (!projects.length) {
      r.state = discovery && authPattern.test(discovery.stderr) ? "auth_required" : discovery && discovery.code !== 0 ? "error" : "not_configured";
      r.message = r.state === "auth_required" ? authMessage(projects) : r.state === "error" ? discovery!.stderr.slice(0, 200) : "Set gcp.projects or run gcloud config set project <project>";
    } else {
      const calls = projects.flatMap(p => [{ tpu: false, zone: "", args: ["compute", "instances", "list", "--format=json", "--project", p] }, ...(cfg.gcp?.includeTpus !== false ? (cfg.gcp?.zones || []).map(z => ({ tpu: true, zone: z, args: ["compute", "tpus", "tpu-vm", "list", "--format=json", "--project", p, "--zone", z] })) : [])]);
      const results = await Promise.all(calls.map(async c => ({ ...c, result: await safeRun(runner, gcloudCli(cfg), c.args, 9000) })));
      for (const c of results.filter(c => c.result.code === 0)) for (const a of rows(c.result.stdout)) {
        const status = text(a.status || a.state).toUpperCase();
        const running = c.tpu ? status === "READY" : status === "RUNNING";
        const pending = (c.tpu ? ["CREATING", "STARTING"] : ["STAGING", "PROVISIONING"]).includes(status);
        if (!running && !pending) continue;
        const name = tail(a.name), machine = tail(a.machineType);
        const j = job(name, "gcp", name, a.creationTimestamp || a.createTime, now);
        Object.assign(j, { kind: c.tpu ? "tpu" : "vm", status: running ? "running" : "pending", region: c.tpu ? c.zone : tail(a.zone) || null, accelerator: c.tpu ? (a.acceleratorType ? `TPU ${a.acceleratorType}` : null) : accelerator(a, machine), detail: machine || null });
        r.jobs.push(j);
      }
      const outcomes = [...(discovery ? [discovery] : []), ...results.map(c => c.result)];
      const errors = outcomes.map(c => c.stderr).join("\n");
      if (authPattern.test(errors)) { r.state = "auth_required"; r.message = authMessage(projects); }
      else if (outcomes.some(c => c.code !== 0)) { r.state = "error"; r.message = errors.slice(0, 200); }
    }
  } catch (e) { r.state = "error"; r.message = String(e).slice(0, 200); }
  r.latencyMs = Date.now() - begin; return r;
}
