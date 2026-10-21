#!/usr/bin/env node
// Install the Trackio interactive chart & dashboard bootstrap into direct pi-web pages.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.PI_WEB_DIR || join(homedir(), ".local/share/pi-web/node_modules/@agegr/pi-web");
const bundle = readFileSync(new URL("../src/web-bootstrap.js", import.meta.url), "utf8");
const chunks = join(root, ".next/static/chunks/app");

if (existsSync(chunks)) {
  for (const name of readdirSync(chunks).filter((n) => /^page-.*\.js$/.test(n))) {
    const file = join(chunks, name);
    const original = readFileSync(file, "utf8").replace(
      /\n\/\* pi-trackio-entry:start \*\/[\s\S]*?\/\* pi-trackio-entry:end \*\//g,
      "",
    );
    writeFileSync(file, original + "\n/* pi-trackio-entry:start */\n" + bundle + "\n/* pi-trackio-entry:end */\n");
  }
}

const pages = join(root, ".next/server/app");
for (const name of ["index.html", "_not-found.html", "login.html"]) {
  const file = join(pages, name);
  if (!existsSync(file)) continue;
  let html = readFileSync(file, "utf8").replace(/<script id="pi-web-trackio-bootstrap">[\s\S]*?<\/script>/g, "");
  html = html.replace(
    "</head>",
    '<script id="pi-web-trackio-bootstrap">' + bundle.replace(/<\/script/gi, "<\\/script") + "</script></head>",
  );
  writeFileSync(file, html);
}
console.log("Installed direct Pi-web Trackio entry.");
