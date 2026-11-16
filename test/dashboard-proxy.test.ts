import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { chartsPage, createTrackioRouteHandler, dashboardLogsRequest, rewriteTrackioHtml } from "../src/web-proxy.ts";
import { runActivity } from "../src/client.ts";
import { lifecycleTarget } from "../src/run-lifecycle.ts";

test("provider records require exact tracked identities and safe paths", () => {
  const config = { plan: { run_id: "run-1", experiment: "v4_example", executor: "modal" }, provenance: { commit: "abc" } };
  const row = { run_id: "tracker-id", run_name: "run-1", config: JSON.stringify(config) };
  assert.equal(lifecycleTarget(row).path, "v4_example/run-1/run.json");
  assert.equal(lifecycleTarget({ ...row, run_name: "alias" }).path, undefined);
  config.plan.experiment = "../escape";
  assert.equal(lifecycleTarget({ ...row, config: JSON.stringify(config) }).path, undefined);
});

test("activity distinguishes recent metrics, telemetry, quiet and unknown without inventing completion", () => {
  const now = Date.parse("2026-10-22T04:00:00Z");
  assert.equal(runActivity({ last_metric: "2026-10-22T03:59:30" }, now).state, "updating");
  assert.equal(runActivity({ last_metric: "2026-10-21T03:59:30Z", last_system: "2026-10-22T03:59:30Z" }, now).state, "telemetry-only");
  assert.equal(runActivity({ last_metric: "2026-10-21T03:59:30Z" }, now).state, "quiet");
  assert.equal(runActivity({ last_metric: "invalid" }, now).state, "unknown");
  assert.equal(runActivity({ last_metric: "2026-10-23T04:00:00Z" }, now).state, "unknown");
});

test("all-charts entry shares the explorer and safely encodes project names", () => {
  const html = chartsPage(new URL("http://localhost/__trackio/charts?project=%3C/script%3E"));
  assert.ok(html.includes("\\u003c/script>"));
  assert.ok(html.includes('src="/__trackio/bootstrap.js"'));
  assert.ok(html.includes('"allRuns":true'));
  assert.ok(rewriteTrackioHtml("<html><head></head><body></body></html>").includes("All charts · Run activity"));
});

test("dashboard history defaults bound the entire run selection", () => {
  assert.equal(dashboardLogsRequest({ runs: ["one"] }).max_points, 500);
  const runs = Array.from({ length: 29 }, (_, i) => `run-${i}`);
  assert.ok(Number(dashboardLogsRequest({ runs }).max_points) * runs.length <= 4000);
  assert.equal(dashboardLogsRequest({ runs, max_points: 220 }).max_points, 220);
});

test("dashboard proxy forwards reload checks and bounded request bodies", async () => {
  const originalUrl = process.env.TRACKIO_SERVER_URL;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, body: raw ? JSON.parse(raw) : null }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address() as { port: number };
  process.env.TRACKIO_SERVER_URL = `http://127.0.0.1:${upstreamAddress.port}`;
  const handler = createTrackioRouteHandler();
  const proxy = createServer((req, res) => { void handler(req, res); });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address() as { port: number };
  const base = `http://127.0.0.1:${proxyAddress.port}`;
  try {
    const version = await fetch(`${base}/__trackio/frontend_version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).url, "/__trackio/frontend_version");
    const overview = await fetch(`${base}/__trackio/app/?project=SimplexFlow-v2&smoothing=10`, { redirect: "manual" });
    assert.equal(overview.status, 302);
    const location = new URL(overview.headers.get("location")!, base);
    assert.equal(location.searchParams.get("project"), "SimplexFlow-v2");
    assert.equal(location.searchParams.get("smoothing"), "10");
    assert.ok(location.searchParams.get("metric_filter"));
    const response = await fetch(`${base}/__trackio/app/api/get_logs_batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "example", runs: ["one", "two"] }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.url, "/api/get_logs_batch");
    assert.deepEqual(result.body, { project: "example", runs: ["one", "two"], max_points: 500 });
  } finally {
    if (originalUrl === undefined) delete process.env.TRACKIO_SERVER_URL;
    else process.env.TRACKIO_SERVER_URL = originalUrl;
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
});
