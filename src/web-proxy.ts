import { readFileSync } from "node:fs";
import {
  request as httpRequest,
  Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTrackioConfig, trackioClient } from "./client.ts";
import { collectComputeSnapshot } from "./compute/snapshot.ts";
import { computePage } from "./compute/page.ts";
import type { ComputeSnapshot } from "./compute/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = join(__dirname, "web-bootstrap.js");
const STATUS_PANEL_PATH = join(__dirname, "run-status-panel.js");

import { existsSync } from "node:fs";
import { homedir } from "node:os";

const ROUTE_SLOT = Symbol.for("pi-trackio.httpRouteSlot");
const HTML_HOOK_SLOT = Symbol.for("pi-trackio.htmlHookSlotV2");
const PI_WEB_ROOT = join(homedir(), ".local/share/pi-web/node_modules/@agegr/pi-web");
const PI_WEB_INDEX_HTML = join(PI_WEB_ROOT, ".next/server/app/index.html");
const PI_WEB_APP_CHUNKS_DIR = join(PI_WEB_ROOT, ".next/static/chunks/app");

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

interface RouteSlotState {
  version: number;
  handler: RouteHandler;
}

export interface TrackioProxyOptions {
  /** Upstream pi-web URL for verifying session auth when PI_WEB_PASSWORD is set. */
  piWebUrl?: string | null;
  /** Always verify upstream pi-web auth on every request. */
  verifyUpstream?: boolean;
  /** Test seam: replaces the live provider collectors. */
  computeSnapshot?: () => Promise<ComputeSnapshot>;
  /** Test seam: replaces the live dashboard HTML. */
  computePageHtml?: () => string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "x-frame-options",
  "content-security-policy",
]);

const ALLOWED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "range",
  "user-agent",
  "cache-control",
] as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(buf.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(buf);
}

function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void {
  const buf = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": String(buf.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(buf);
}

function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function isUnsafeUrlPath(rawUrl: string): boolean {
  if (rawUrl.includes("\r") || rawUrl.includes("\n") || rawUrl.includes("\0")) return true;
  if (/(?:^|[\/]|%2f)\.\.(?:[\/\?]|%2f|$)/i.test(rawUrl)) return true;
  if (/%2e%2e/i.test(rawUrl)) return true;
  return false;
}

export function checkSameOriginCsrf(
  req: IncomingMessage,
  options: { requireCustomHeader?: boolean } = {},
): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;

  const secFetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  }

  if (options.requireCustomHeader) {
    if (req.headers["x-pi-trackio"] !== "1") return false;
  }

  return true;
}

async function isPiWebAuthorized(
  req: IncomingMessage,
  options: TrackioProxyOptions,
): Promise<boolean> {
  const passwordConfigured = Boolean(process.env.PI_WEB_PASSWORD);
  if (!passwordConfigured && !options.verifyUpstream) return true;
  const piWebUrl = (
    options.piWebUrl ??
    process.env.PI_WEB_URL ??
    "http://127.0.0.1:30141"
  ).replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (typeof req.headers.cookie === "string") headers.cookie = req.headers.cookie;
  if (typeof req.headers.authorization === "string") headers.authorization = req.headers.authorization;
  try {
    const res = await fetch(`${piWebUrl}/api/agent/running`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export function rewriteTrackioHtml(html: string, basePath = "/__trackio/app"): string {
  let out = html
    .replace(/href="\/assets\//g, `href="${basePath}/assets/`)
    .replace(/src="\/assets\//g, `src="${basePath}/assets/`)
    .replace(/src="\/static\/trackio\//g, `src="${basePath}/static/trackio/`);
  if (!out.includes("window.__trackio_base")) {
    out = out.replace(
      /<head>/i,
      `<head><script>window.__trackio_base = ${JSON.stringify(basePath)};</script>`,
    );
  }
  if (!out.includes('id="pi-trackio-all-charts"')) {
    out = out.replace(/<body>/i, `<body><nav id="pi-trackio-all-charts" style="height:34px;padding:6px 12px;background:#121827;color:#dbeafe;font:13px system-ui;box-sizing:border-box"><a style="color:#7dd3fc" href="/__trackio/charts">All charts · Run activity</a><span style="margin-left:12px">One scrollable dashboard; charts render as you scroll.</span></nav><style>#app>.app{height:calc(100dvh - 34px)!important}</style><script>(()=>{const link=document.querySelector('#pi-trackio-all-charts a');const params=new URLSearchParams(location.search);params.delete('metrics');params.delete('metric_filter');link.search=params.toString();})()</script>`);
  }
  if (!out.includes('src="/__trackio/run-status-panel.js"')) {
    out = out.replace(/<\/body>/i, '<script defer src="/__trackio/run-status-panel.js"></script></body>');
  }
  return out;
}

export function chartsPage(url: URL): string {
  const spec = {
    project: url.searchParams.get("project") || "",
    runs: (url.searchParams.get("runs") || "").split(",").filter(Boolean),
    smoothing: Number(url.searchParams.get("smoothing") || 10),
    metrics: (url.searchParams.get("metrics") || "").split(",").filter(Boolean),
    allRuns: true,
  };
  const json = JSON.stringify(spec).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trackio · All charts</title><style>html,body{margin:0;height:100%;background:#0d1326;color:#f1f5ff;font:13px system-ui}body{display:flex;flex-direction:column}#pi-trackio-standalone{flex:1;min-height:0;display:flex;flex-direction:column}#pi-trackio-standalone .pi-trackio-dock-scroll{overflow:auto;flex:1;min-height:0}#pi-trackio-standalone .pi-trackio-runs-bar{max-height:100px;overflow:auto}#pi-trackio-standalone .pi-trackio-summary-wrap{display:none!important}a{color:#7dd3fc}</style></head><body><div id="pi-trackio-standalone"></div><script>window.__piTrackioStandalone=${json};</script><script src="/__trackio/bootstrap.js"></script></body></html>`;
}

function proxyToTrackio(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPath: string,
  basePath = "/__trackio/app",
  body?: Buffer,
): void {
  const cfg = loadTrackioConfig();
  const upstreamUrl = new URL(cfg.serverUrl);

  const headers: Record<string, string> = {
    host: upstreamUrl.host,
    "accept-encoding": "identity",
  };
  for (const key of ALLOWED_REQUEST_HEADERS) {
    const val = req.headers[key];
    if (typeof val === "string") headers[key] = val;
  }
  if (body) headers["content-length"] = String(body.length);
  if (cfg.writeToken) {
    headers["x-trackio-write-token"] = cfg.writeToken;
    headers.cookie = `trackio_write_token=${encodeURIComponent(cfg.writeToken)}`;
  }

  const isSettingsApi = upstreamPath.startsWith("/api/get_settings");

  const upstreamReq = httpRequest(
    {
      hostname: upstreamUrl.hostname,
      port: Number(upstreamUrl.port) || cfg.port || 30143,
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (upstreamRes) => {
      const contentType = String(upstreamRes.headers["content-type"] ?? "");
      const isHtml = contentType.includes("text/html");
      const outHeaders: Record<string, string | string[]> = {
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "frame-ancestors 'self'",
      };
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!v || HOP_BY_HOP.has(k.toLowerCase())) continue;
        outHeaders[k] = Array.isArray(v) ? v.map(String) : String(v);
      }

      if ((!isHtml && !isSettingsApi) || req.method === "HEAD") {
        if (upstreamRes.headers["content-length"]) {
          outHeaders["content-length"] = String(upstreamRes.headers["content-length"]);
        }
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        upstreamRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let rewritten = raw;
        if (isHtml) {
          rewritten = rewriteTrackioHtml(raw, basePath);
        } else if (isSettingsApi) {
          try {
            const parsed = JSON.parse(raw) as { data?: Record<string, unknown> };
            if (parsed && typeof parsed === "object") {
              parsed.data = parsed.data ?? {};
              parsed.data.logo_urls = {
                light: `${basePath}/static/trackio/trackio_logo_type_light_transparent.png`,
                dark: `${basePath}/static/trackio/trackio_logo_type_dark_transparent.png`,
              };
              rewritten = JSON.stringify(parsed);
            }
          } catch {
            // leave as-is
          }
        }
        const buf = Buffer.from(rewritten, "utf8");
        outHeaders["content-length"] = String(buf.length);
        outHeaders["cache-control"] = "no-store";
        res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
        res.end(buf);
      });
      upstreamRes.on("error", () => res.destroy());
    },
  );

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: `Trackio server unreachable: ${err.message}`,
      });
    } else {
      res.destroy();
    }
  });

  res.on("close", () => upstreamReq.destroy());
  if (body) upstreamReq.end(body);
  else req.pipe(upstreamReq);
}

// Dashboard previews share pi-web's browser thread. Keep the default history
// bounded across the selection, rather than 3,000 rows for every selected run.
// Explicit resolutions (including the native chart view's 220) stay intact.
export function dashboardLogsRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (body.max_points != null) return body;
  const count = Array.isArray(body.runs) ? Math.max(1, body.runs.length) : 1;
  return { ...body, max_points: Math.max(1, Math.min(500, Math.floor(4000 / count))) };
}

export function createTrackioRouteHandler(options: TrackioProxyOptions = {}): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith("/__trackio") && !rawUrl.startsWith("/static/trackio/")) {
      return false;
    }

    if (isUnsafeUrlPath(rawUrl)) {
      sendJson(res, 400, { error: "Invalid request path" });
      return true;
    }

    if (!(await isPiWebAuthorized(req, options))) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }

    const url = new URL(rawUrl, `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;

    if (pathname === "/__trackio/compute" && (req.method === "GET" || req.method === "HEAD")) {
      sendText(res, 200, (options.computePageHtml ?? computePage)(), "text/html; charset=utf-8");
      return true;
    }
    if (pathname === "/__trackio/compute.json" && req.method === "GET") {
      try {
        sendJson(res, 200, await (options.computeSnapshot ?? (() => collectComputeSnapshot({ force: url.searchParams.get("force") === "1" })))());
      } catch (error) { sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }); }
      return true;
    }

    if (pathname === "/__trackio/charts" && (req.method === "GET" || req.method === "HEAD")) {
      sendText(res, 200, chartsPage(url), "text/html; charset=utf-8");
      return true;
    }

    if (pathname === "/__trackio/activity" && req.method === "GET") {
      const project = url.searchParams.get("project");
      if (!project) sendJson(res, 400, { error: "project is required" });
      else {
        try { sendJson(res, 200, await trackioClient.getRunActivity(project)); }
        catch (error) { sendJson(res, 502, { error: (error as Error).message }); }
      }
      return true;
    }

    if (pathname === "/__trackio/frontend_version" && (req.method === "GET" || req.method === "HEAD")) {
      proxyToTrackio(req, res, pathname + url.search);
      return true;
    }

    if (pathname.startsWith("/static/trackio/")) {
      proxyToTrackio(req, res, pathname + url.search, "/__trackio/app");
      return true;
    }

    if (["/__trackio/bootstrap.js", "/__trackio/run-status-panel.js"].includes(pathname) && (req.method === "GET" || req.method === "HEAD")) {
      try {
        const js = readFileSync(pathname.endsWith("run-status-panel.js") ? STATUS_PANEL_PATH : BOOTSTRAP_PATH, "utf8");
        sendText(res, 200, js, "text/javascript; charset=utf-8");
      } catch (err) {
        sendText(res, 500, `// bootstrap load error: ${(err as Error)?.message ?? err}`, "text/javascript");
      }
      return true;
    }

    if (pathname === "/__trackio/status" && req.method === "GET") {
      const status = await trackioClient.getStatus();
      sendJson(res, 200, {
        healthy: status.healthy,
        version: status.version,
        projects: status.projects,
        projectRunCounts: status.projectRunCounts,
        gcsConfigured: Boolean(status.gcsBucket),
        lastBackupUtc: status.lastBackupUtc,
        dbCount: status.dbFiles.length,
        error: status.error,
      });
      return true;
    }

    if (pathname === "/__trackio/backup" && req.method === "POST") {
      if (!checkSameOriginCsrf(req, { requireCustomHeader: true })) {
        sendJson(res, 403, { ok: false, error: "Forbidden (CSRF check failed)" });
        return true;
      }
      try {
        const body = await readJsonBody(req).catch((): Record<string, unknown> => ({}));
        const result = await trackioClient.triggerBackup({
          localOnly: Boolean(body.localOnly),
        });
        sendJson(res, 200, {
          ok: result.ok,
          lastBackupUtc: result.lastBackupUtc,
          gcsConfigured: Boolean(result.gcsBucket),
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) });
      }
      return true;
    }

    if (pathname === "/__trackio/series" && req.method === "POST") {
      if (!checkSameOriginCsrf(req, { requireCustomHeader: true })) {
        sendJson(res, 403, { error: "Forbidden (CSRF check failed)" });
        return true;
      }
      try {
        const body = await readJsonBody(req);
        const series = await trackioClient.getPlotSeries({
          project: typeof body.project === "string" ? body.project : undefined,
          runs: Array.isArray(body.runs) ? body.runs.map(String) : undefined,
          metrics: Array.isArray(body.metrics) ? body.metrics.map(String) : undefined,
          xAxis: typeof body.xAxis === "string" ? body.xAxis : undefined,
          maxPoints: typeof body.maxPoints === "number" ? body.maxPoints : undefined,
        });
        sendJson(res, 200, series);
      } catch (err) {
        sendJson(res, 500, { error: String((err as Error)?.message ?? err) });
      }
      return true;
    }

    if (pathname === "/__trackio" || pathname === "/__trackio/") {
      res.writeHead(302, { location: `/__trackio/app/${url.search}` });
      res.end();
      return true;
    }

    if (pathname === "/__trackio/app" || pathname.startsWith("/__trackio/app/")) {
      if (!checkSameOriginCsrf(req)) {
        sendJson(res, 403, { error: "Forbidden (cross-origin mutation blocked)" });
        return true;
      }
      const subPath = pathname.slice("/__trackio/app".length) || "/";
      if ((subPath === "/" || subPath === "") && req.method === "GET" &&
          !url.searchParams.get("metrics") && !url.searchParams.get("metric_filter")) {
        // Old bookmarks otherwise mount every metric in the project at once.
        url.searchParams.set("metric_filter", "^(loss|ce|train/(loss|ce|grad_norm|lr)|eval/(loss|heldout_ce))$");
        res.writeHead(302, { location: url.pathname + url.search, "cache-control": "no-store" });
        res.end();
        return true;
      }
      if (subPath === "/api/get_logs_batch" && req.method === "POST") {
        try {
          const body = dashboardLogsRequest(await readJsonBody(req));
          proxyToTrackio(req, res, subPath + url.search, "/__trackio/app", Buffer.from(JSON.stringify(body)));
        } catch (error) {
          sendJson(res, 400, { error: (error as Error).message });
        }
        return true;
      }
      proxyToTrackio(req, res, subPath + url.search, "/__trackio/app");
      return true;
    }

    sendJson(res, 404, { error: `Unknown Trackio route: ${pathname}` });
    return true;
  };
}

export function findPiWebServer(): HttpServer | null {
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof getHandles !== "function") return null;
  const cfg = loadTrackioConfig();
  const wantedPort = Number(process.env.PI_WEB_PORT || 30141);
  let fallbackLoopback: HttpServer | null = null;

  for (const handle of getHandles.call(process)) {
    if (handle instanceof HttpServer && handle.listening) {
      const addr = handle.address();
      if (!addr || typeof addr !== "object" || addr.port === cfg.port) continue;
      if (addr.port === wantedPort) return handle;
      if (addr.address === "127.0.0.1" || addr.address === "::1" || addr.address === "localhost") {
        fallbackLoopback = handle;
      }
    }
  }
  return fallbackLoopback;
}

export function attachTrackioRoutes(
  server: HttpServer,
  handler: RouteHandler = createTrackioRouteHandler(),
  version = 7,
): boolean {
  const host = server as unknown as Record<symbol, RouteSlotState | undefined>;

  // Attach HTML & patched-chunk hook so GET / and /_next/static/chunks/app/page-*.hp*.js on :30141 serve fresh from disk
  if (!host[HTML_HOOK_SLOT]) {
    host[HTML_HOOK_SLOT] = { version, handler };
    const prevEmit = server.emit.bind(server);
    server.emit = function (event: string, ...args: unknown[]): boolean {
      if (event === "request") {
        const [req, res] = args as [IncomingMessage, ServerResponse];
        const rawUrl = req?.url ?? "";
        const qIdx = rawUrl.indexOf("?");
        const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
        if (req.method === "GET" || req.method === "HEAD") {
          if (
            pathname === "/" &&
            !req.headers["rsc"] &&
            !req.headers["next-router-prefetch"] &&
            existsSync(PI_WEB_INDEX_HTML)
          ) {
            try {
              const html = readFileSync(PI_WEB_INDEX_HTML, "utf8");
              sendText(res, 200, html, "text/html; charset=utf-8");
              return true;
            } catch {
              // fall through
            }
          }
          const chunkMatch = /^\/_next\/static\/chunks\/app\/(page-[A-Za-z0-9_.-]+\.js)$/.exec(pathname);
          if (chunkMatch) {
            const chunkPath = join(PI_WEB_APP_CHUNKS_DIR, chunkMatch[1]);
            if (existsSync(chunkPath)) {
              try {
                const js = readFileSync(chunkPath, "utf8");
                sendText(res, 200, js, "application/javascript; charset=utf-8");
                return true;
              } catch {
                // fall through
              }
            }
          }
        }
      }
      return prevEmit(event, ...args);
    } as typeof server.emit;
  }

  const existing = host[ROUTE_SLOT];
  if (existing) {
    if (existing.version > version) return false;
    existing.handler = handler;
    existing.version = version;
    return true;
  }

  const slot: RouteSlotState = { version, handler };
  host[ROUTE_SLOT] = slot;

  const origEmit = server.emit.bind(server);
  server.emit = function (event: string, ...args: unknown[]): boolean {
    if (event === "request") {
      const [req, res] = args as [IncomingMessage, ServerResponse];
      const url = req?.url ?? "";
      if (url.startsWith("/__trackio") || url.startsWith("/static/trackio/")) {
        Promise.resolve(slot.handler(req, res)).catch((err) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: String((err as Error)?.message ?? err) });
          } else {
            res.destroy();
          }
        });
        return true;
      }
    }
    return origEmit(event, ...args);
  } as typeof server.emit;

  return true;
}
