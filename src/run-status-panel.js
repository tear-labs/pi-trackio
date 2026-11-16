// Small status table for the native Trackio UI; never mounts metric charts.
(() => {
  const nav = document.getElementById("pi-trackio-all-charts");
  if (!nav || document.getElementById("pi-trackio-job-status")) return;
  const details = document.createElement("details");
  details.id = "pi-trackio-job-status";
  details.style.cssText = "display:inline-block;margin-left:18px;position:relative;z-index:10000";
  const summary = document.createElement("summary");
  summary.textContent = "Run status: checking…";
  summary.style.cursor = "pointer";
  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;top:36px;left:12px;width:min(900px,calc(100vw - 24px));box-sizing:border-box;max-height:65vh;overflow:auto;background:#121827;border:1px solid #475569;border-radius:8px;padding:12px;box-shadow:0 12px 28px #0008";
  const filter = document.createElement("select");
  filter.setAttribute("aria-label", "Filter job status table");
  for (const [value, label] of [["all", "All states"], ["running", "Running only"], ["finished", "Finished / stopped"], ["unknown", "Unknown / checking"]]) {
    const option = document.createElement("option");
    option.value = value; option.textContent = label; filter.append(option);
  }
  const note = document.createElement("p");
  note.textContent = "Worker/provider status, checked every 30s. Recent metric logs are separate from job state.";
  note.style.cssText = "margin:8px 0;color:#94a3b8;font-size:12px";
  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;text-align:left;font-size:12px";
  panel.append(filter, note, table);
  details.append(summary, panel); nav.append(details);
  let rows = [], project = "", busy = false;

  function render() {
    table.replaceChildren();
    const header = table.insertRow();
    for (const name of ["Run", "Job state", "Source / checked"]) {
      const cell = document.createElement("th"); cell.textContent = name; header.append(cell);
    }
    const shown = rows.filter(r => filter.value === "all" ||
      (filter.value === "running" && r.job?.status === "running") ||
      (filter.value === "finished" && ["completed", "failed", "cancelled", "stopped"].includes(r.job?.status)) ||
      (filter.value === "unknown" && ["unknown", "checking"].includes(r.job?.status || "unknown")));
    for (const row of shown) {
      const tr = table.insertRow();
      const link = document.createElement("a");
      link.textContent = row.run_name;
      link.href = `/__trackio/charts?${new URLSearchParams({ project, runs: row.run_name })}`;
      link.style.cssText = "color:#7dd3fc;overflow-wrap:anywhere";
      tr.insertCell().append(link);
      const state = tr.insertCell();
      state.textContent = (row.job?.label || "Unknown") + (row.job?.source === "Trackio config (reported)" ? " (reported)" : "");
      state.style.color = row.job?.status === "running" ? "#4ade80" : row.job?.status === "failed" ? "#fb7185" : "#cbd5e1";
      const source = tr.insertCell();
      source.textContent = `${row.job?.source || "unavailable"} · ${row.job?.checkedAt ? new Date(row.job.checkedAt).toLocaleTimeString() : "not checked"}`;
      tr.title = row.job?.detail || "";
      for (const cell of tr.cells) cell.style.cssText += ";padding:6px 8px;border-bottom:1px solid #334155;vertical-align:top";
    }
    if (!shown.length) table.insertRow().insertCell().textContent = "No runs match this filter.";
  }
  filter.onchange = render;

  async function refresh() {
    if (busy || document.hidden) return;
    project = new URLSearchParams(location.search).get("project") || "";
    if (!project) { summary.textContent = "Run status: select a project"; return; }
    busy = true;
    try {
      const response = await fetch(`/__trackio/activity?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Status unavailable");
      rows = (await response.json()).runs || [];
      const running = rows.filter(r => r.job?.status === "running").length;
      const checking = rows.some(r => r.job?.status === "checking");
      summary.textContent = `Run status: ${running} running / ${rows.length} total${checking ? " · checking…" : ""}`;
      render();
    } catch {
      rows = []; summary.textContent = "Run status unavailable"; render();
    } finally { busy = false; }
  }
  void refresh();
  setInterval(refresh, 5000);
})();
