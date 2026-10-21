#!/usr/bin/env node
// Install the Trackio interactive chart & dashboard bootstrap into direct pi-web pages,
// route-cache HTML files, and Service Worker STATIC_CACHE.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.PI_WEB_DIR || join(homedir(), ".local/share/pi-web/node_modules/@agegr/pi-web");
const bundle = readFileSync(new URL("../src/web-bootstrap.js", import.meta.url), "utf8");
const hash = createHash("sha256").update(bundle).digest("hex").slice(0, 8);
const chunks = join(root, ".next/static/chunks/app");

if (existsSync(chunks)) {
  for (const name of readdirSync(chunks).filter((n) => /^page-.*\.js$/.test(n) && !/\.hp[0-9a-zA-Z_-]+\.js$/.test(n))) {
    const file = join(chunks, name);
    const original = readFileSync(file, "utf8").replace(
      /\n\/\* pi-trackio-entry:start \*\/[\s\S]*?\/\* pi-trackio-entry:end \*\//g,
      "",
    );
    writeFileSync(file, original + "\n/* pi-trackio-entry:start */\n" + bundle + "\n/* pi-trackio-entry:end */\n");
  }
}

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

const htmlFiles = [
  ...walkFiles(join(root, ".next/server/app"), (f) => f.endsWith(".html")),
  ...walkFiles(join(root, ".next/server/route-cache"), (f) => f.endsWith(".html")),
];

const scriptTag = '<script id="pi-web-trackio-bootstrap">' + bundle.replace(/<\/script/gi, "<\\/script") + "</script>";
for (const file of htmlFiles) {
  let html = readFileSync(file, "utf8").replace(/<script id="pi-web-trackio-bootstrap">[\s\S]*?<\/script>/g, "");
  if (html.includes("</head>")) {
    html = html.replace("</head>", scriptTag + "</head>");
    writeFileSync(file, html);
  }
}

const swFile = join(root, "public/sw.js");
if (existsSync(swFile)) {
  const sw = readFileSync(swFile, "utf8").replace(
    /const STATIC_CACHE = `\$\{CACHE_PREFIX\}-static-\$\{CACHE_VERSION\}[^\`;]*`;/,
    `const STATIC_CACHE = \`\${CACHE_PREFIX}-static-\${CACHE_VERSION}-trk-${hash}\`;`,
  );
  writeFileSync(swFile, sw);
}

console.log(`Installed direct Pi-web Trackio entry (${htmlFiles.length} HTML files, sw cache: trk-${hash}).`);
