import { job, modalCli, report, rows, safeRun, text, type ComputeConfig } from "./config.ts";
import type { ProviderReport, Runner } from "./types.ts";
export async function collectModal(cfg: ComputeConfig, runner: Runner, now: number): Promise<ProviderReport> {
  const r = report("modal", now), begin = Date.now();
  try {
    const envs = cfg.modal?.environments;
    const results = await Promise.all((envs?.length ? envs : [""]).map(async env => {
      const suffix = env ? ["--env", env] : [];
      const [containers, apps] = await Promise.all([safeRun(runner, modalCli(cfg), ["container", "list", "--json", ...suffix], 9000), safeRun(runner, modalCli(cfg), ["app", "list", "--json", ...suffix], 9000)]);
      return { env, containers, apps };
    }));
    const commands = results.flatMap(x => [x.containers, x.apps]);
    const partial = results.flatMap(x => (["container", "app"] as const).flatMap(kind => {
      const c = kind === "container" ? x.containers : x.apps;
      return c.code !== 0 && !c.stderr.includes("ENOENT") ? [`Partial: modal ${kind} list failed (${c.stderr.slice(0, 120)})`] : [];
    }));
    if (commands.some(c => c.code === 0) && partial.length) r.message = partial.join(" · ");
    if (commands.every(c => c.code !== 0)) {
      r.state = commands.every(c => c.stderr.includes("ENOENT")) ? "not_configured" : "error";
      r.message = r.state === "not_configured" ? "Modal CLI not found (looked for modal on PATH and ~/.local/bin/modal)" : commands[0].stderr.slice(0, 200);
    } else for (const { env, containers, apps } of results) {
      const terminal = /^(stopped|terminated|failed|exited|done|completed)$/i;
      const cs = containers.code === 0 ? rows(containers.stdout).filter(c => !terminal.test(text(c.status).trim()) && !terminal.test(text(c.state).trim())) : [];
      const as = apps.code === 0 ? rows(apps.stdout) : [];
      const ids = new Set([...cs, ...as.filter(a => Number(a.tasks) > 0)].map(a => text(a.app_id)));
      for (const id of ids) {
        const group = cs.filter(c => c.app_id === id), app = as.find(a => a.app_id === id);
        if (app?.stopped_at != null || /^(stopped|terminated|failed|cancelled)/i.test(text(app?.state).split(" (")[0].trim())) continue;
        const replicas = group.length || Number(app?.tasks) || 0;
        const starts = group.map(c => text(c.start_time)).filter(Boolean).sort();
        const j = job(id, "modal", text(app?.description) || text(group[0]?.app_name) || id, app?.created_at || starts[0], now);
        Object.assign(j, { kind: "app", status: replicas > 0 ? "running" : "pending", replicas, detail: [text(app?.state), `${replicas} ${group.length ? "container" : "task"}${replicas === 1 ? "" : "s"}`, env].filter(Boolean).join(" · ") });
        const existing = r.jobs.find(x => x.id === id);
        if (!existing) r.jobs.push(j);
        else existing.detail = `${existing.detail} · ${env}`;
      }
    }
  } catch (e) { r.state = "error"; r.message = String(e).slice(0, 200); }
  r.latencyMs = Date.now() - begin; return r;
}
