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

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = join(__dirname, "web-bootstrap.js");

import { existsSync } from "node:fs";
import { homedir } from "node:os";

const ROUTE_SLOT = Symbol.for("pi-trackio.httpRouteSlot");
const HTML_HOOK_SLOT = Symbol.for("pi-trackio.htmlHookSlot");
const PI_WEB_INDEX_HTML = join(
  homedir(),
  ".local/share/pi-web/node_modules/@agegr/pi-web/.next/server/app/index.html",
);

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
  return out;
}

function proxyToTrackio(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPath: string,
  basePath = "/__trackio/app",
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
  req.pipe(upstreamReq);
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

    if (pathname.startsWith("/static/trackio/")) {
      proxyToTrackio(req, res, pathname + url.search, "/__trackio/app");
      return true;
    }

    if (pathname === "/__trackio/bootstrap.js" && (req.method === "GET" || req.method === "HEAD")) {
      try {
        const js = readFileSync(BOOTSTRAP_PATH, "utf8");
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
  version = 3,
): boolean {
  const host = server as unknown as Record<symbol, RouteSlotState | undefined>;

  // Attach HTML cache-bypass hook so GET / on :30141 serves the fresh on-disk index.html
  if (!host[HTML_HOOK_SLOT]) {
    host[HTML_HOOK_SLOT] = { version, handler };
    const prevEmit = server.emit.bind(server);
    server.emit = function (event: string, ...args: unknown[]): boolean {
      if (event === "request") {
        const [req, res] = args as [IncomingMessage, ServerResponse];
        const rawUrl = req?.url ?? "";
        const qIdx = rawUrl.indexOf("?");
        const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
        if (
          (req.method === "GET" || req.method === "HEAD") &&
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
            // fall through to Next.js
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
