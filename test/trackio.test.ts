import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { loadTrackioConfig, trackioClient } from "../src/client.ts";
import piTrackioExtension, { buildSparkline, TRACKIO_EMBED_TYPE } from "../src/index.ts";
import { attachTrackioRoutes } from "../src/web-proxy.ts";

const TEST_PROJECT = "pi-trackio-e2e-test";

test("pi-trackio client + proxy + extension end-to-end", async () => {
  const cfg = loadTrackioConfig();
  assert.equal(cfg.serverUrl, "http://127.0.0.1:30143");
  assert.ok(cfg.writeToken && cfg.writeToken.length >= 16, "writeToken must be configured");
  assert.ok(cfg.gcsBucket?.startsWith("gs://"), "gcsBucket must be configured");

  try {
    // 1. Log two runs via TrackioClient.logMetrics
    await trackioClient.logMetrics({
      project: TEST_PROJECT,
      run: "baseline-bf16",
      config: { precision: "bf16", lr: 0.0003 },
      metrics: [
        { step: 0, "train/loss": 2.4, "eval/tok_per_s": 118.5 },
        { step: 1, "train/loss": 1.8, "eval/tok_per_s": 120.1 },
        { step: 2, "train/loss": 1.35, "eval/tok_per_s": 121.0 },
      ],
    });

    await trackioClient.logMetrics({
      project: TEST_PROJECT,
      run: "triton-fp8",
      config: { precision: "fp8", lr: 0.0003 },
      metrics: [
        { step: 0, "train/loss": 2.38, "eval/tok_per_s": 212.4 },
        { step: 1, "train/loss": 1.79, "eval/tok_per_s": 218.9 },
        { step: 2, "train/loss": 1.32, "eval/tok_per_s": 221.7 },
      ],
    });

    // 2. Verify client query methods
    const projects = await trackioClient.listProjects();
    assert.ok(projects.includes(TEST_PROJECT), "TEST_PROJECT should appear in listProjects()");

    const runs = await trackioClient.listRuns(TEST_PROJECT);
    const runNames = runs.map((r) => r.name);
    assert.ok(runNames.includes("baseline-bf16") && runNames.includes("triton-fp8"));

    const series = await trackioClient.getPlotSeries({
      project: TEST_PROJECT,
      runs: ["baseline-bf16", "triton-fp8"],
      metrics: ["train/loss", "eval/tok_per_s"],
    });
    assert.equal(series.project, TEST_PROJECT);
    assert.equal(series.series.length, 2);
    assert.equal(series.series[0].metrics["train/loss"].length, 3);

    const sqlRes = (await trackioClient.querySql(
      TEST_PROJECT,
      "SELECT run_name, COUNT(*) AS n FROM metrics GROUP BY run_name ORDER BY run_name",
    )) as { rows?: Array<Record<string, unknown>>; row_count?: number };
    const sqlRows = Array.isArray(sqlRes) ? sqlRes : sqlRes.rows;
    assert.ok(Array.isArray(sqlRows) && sqlRows.length === 2);

    await assert.rejects(
      () => trackioClient.querySql(TEST_PROJECT, "ATTACH DATABASE '/tmp/pwn.db' AS pwn"),
      /Only read-only SELECT/,
    );

    // 3. Verify HTTP proxy routes on an ephemeral server
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end("not handled");
    });
    attachTrackioRoutes(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const bootRes = await fetch(`${base}/__trackio/bootstrap.js`);
      assert.equal(bootRes.status, 200);
      const bootJs = await bootRes.text();
      assert.ok(bootJs.includes("pi-trackio-card"));
      assert.ok(bootJs.includes("pi-web-trackio-toolbar"));

      const statusRes = await fetch(`${base}/__trackio/status`);
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as { healthy: boolean; version: string };
      assert.equal(statusJson.healthy, true);
      assert.equal(statusJson.version, "0.43.0");

      // Verify CSRF guard rejects POST without x-pi-trackio header
      const csrfReject = await fetch(`${base}/__trackio/series`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: TEST_PROJECT }),
      });
      assert.equal(csrfReject.status, 403);

      // Verify path traversal guard rejects ..%2f
      const travReject = await fetch(`${base}/__trackio/app/..%2fetc/passwd`);
      assert.equal(travReject.status, 400);

      const seriesRes = await fetch(`${base}/__trackio/series`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-trackio": "1" },
        body: JSON.stringify({ project: TEST_PROJECT }),
      });
      assert.equal(seriesRes.status, 200);
      const seriesJson = (await seriesRes.json()) as { project: string; availableMetrics: string[] };
      assert.equal(seriesJson.project, TEST_PROJECT);
      assert.ok(seriesJson.availableMetrics.includes("train/loss"));

      const htmlRes = await fetch(`${base}/__trackio/app/?project=${TEST_PROJECT}`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes('window.__trackio_base = "/__trackio/app"'));
      assert.ok(html.includes('/__trackio/app/assets/'));

      const settingsRes = await fetch(`${base}/__trackio/app/api/get_settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(settingsRes.status, 200);
      const settingsJson = (await settingsRes.json()) as {
        data: { logo_urls: { light: string; dark: string } };
      };
      assert.ok(settingsJson.data.logo_urls.light.startsWith("/__trackio/app/static/trackio/"));
    } finally {
      server.close();
    }

    // 4. Verify extension tool registration & context filter
    const registeredTools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const sentMessages: Array<{ customType: string; content: string; display: boolean }> = [];
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();

    const mockPi = {
      on(event: string, fn: (event: Record<string, unknown>) => unknown) {
        handlers.set(event, fn);
      },
      registerMessageRenderer() {},
      registerCommand() {},
      registerTool(tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
        registeredTools.set(tool.name, tool);
      },
      sendMessage(msg: { customType: string; content: string; display: boolean }) {
        sentMessages.push(msg);
      },
    };

    piTrackioExtension(mockPi as unknown as Parameters<typeof piTrackioExtension>[0]);
    assert.deepEqual(
      [...registeredTools.keys()].sort(),
      ["trackio_log", "trackio_plot", "trackio_query", "trackio_status"],
    );

    const plotTool = registeredTools.get("trackio_plot")!;
    const plotRes = (await plotTool.execute("call-1", {
      project: TEST_PROJECT,
      metrics: ["train/loss", "eval/tok_per_s"],
      title: "Decode Benchmark",
    })) as { content: Array<{ text: string }> };

    assert.ok(plotRes.content[0].text.includes("```trackio"));
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].customType, TRACKIO_EMBED_TYPE);

    const contextHandler = handlers.get("context")!;
    const filtered = contextHandler({
      messages: [
        { role: "user", content: "hi" },
        { role: "custom", customType: TRACKIO_EMBED_TYPE, content: sentMessages[0].content },
      ],
    }) as { messages: Array<{ role: string }> };
    assert.equal(filtered.messages.length, 1);
    assert.equal(filtered.messages[0].role, "user");

    assert.ok(buildSparkline([1, 2, 3, 4]).length === 4);
  } finally {
    rmSync(join(cfg.trackioDir, `${TEST_PROJECT}.db`), { force: true });
    rmSync(join(cfg.trackioDir, `${TEST_PROJECT}.db-wal`), { force: true });
    rmSync(join(cfg.trackioDir, `${TEST_PROJECT}.db-shm`), { force: true });
    rmSync(join(cfg.trackioDir, `${TEST_PROJECT}.lock`), { force: true });
  }
});
