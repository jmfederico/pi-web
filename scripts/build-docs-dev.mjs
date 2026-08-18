#!/usr/bin/env node
// Assembles the "dev" variant of the pi-web.dev docs site into docs/.deploy/dev.
//
// The dev variant is served by the pi-web-docs-dev Cloudflare Worker, which owns the
// pi-web.dev/dev/* route, so every page is nested under a dev/ directory. Pages use
// relative asset and link URLs, so they work unchanged under the /dev/ prefix.
//
// Differences from the stable site:
// - Every HTML page gets a <meta name="robots" content="noindex" /> tag and a banner
//   linking back to the stable page (robots.txt is host-wide and served by the stable
//   worker, so dev pages must opt out of indexing per page).
// - sitemap.xml, robots.txt, and the original _redirects are dropped: they only make
//   sense on the stable host root and the dev worker only receives /dev/* requests.
// - 404.html is placed at the staging root (Workers "404-page" handling requires it
//   there). It keeps its absolute URLs, so its styles and links come from stable.
//
// The script is dependency-free so it can run in CI without npm ci.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(scriptDir, "../docs");
const outDir = path.join(docsDir, ".deploy/dev");
const pagesDir = path.join(outDir, "dev");

const excludedEntries = new Set([
  "_redirects",
  "404.html",
  "robots.txt",
  "sitemap.xml",
  "wrangler.dev.jsonc",
  "wrangler.jsonc",
]);

function resolveGitSha() {
  const fromEnv = (process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(fromEnv)) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: docsDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function stableUrlFor(htmlFileName) {
  if (htmlFileName === "index.html") return "https://pi-web.dev/";
  return `https://pi-web.dev/${htmlFileName.replace(/\.html$/, "")}`;
}

function bannerHtml(sha, stableUrl) {
  const source = sha
    ? `<a href="https://github.com/jmfederico/pi-web/commit/${sha}" style="color:inherit;text-decoration:underline;">main@${sha.slice(0, 7)}</a>`
    : "the main branch";
  const linkStyle = "color:inherit;text-decoration:underline;font-weight:600;";
  return (
    `<div style="padding:8px 16px;background:#b45309;color:#fff7ed;text-align:center;` +
    `font:500 14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;">` +
    `Development docs built from ${source} — content may not match the latest release. ` +
    `<a href="${stableUrl}" style="${linkStyle}">View stable version →</a></div>`
  );
}

// Dev copies flip the footer version switcher: source pages default to Stable active,
// the dev variant marks Dev active instead. Both patterns must match exactly once so
// source markup drift fails the deploy instead of silently shipping a wrong switcher.
function activateDevVersion(html) {
  const stableOption = /(<a\b[^>]*data-version-option="stable"[^>]*?) aria-current="true"/;
  const devOption = /(<a\b[^>]*data-version-option="dev"[^>]*?)>/;
  if (!stableOption.test(html) || !devOption.test(html)) {
    throw new Error("Expected footer version switcher options to flip the active version.");
  }
  return html.replace(stableOption, "$1").replace(devOption, '$1 aria-current="true">');
}

function injectDevMarkers(html, banner) {
  if (!html.includes("<head>")) {
    throw new Error("Expected a <head> tag to inject the noindex meta tag.");
  }
  if (!/<body[^>]*>/.test(html)) {
    throw new Error("Expected a <body> tag to inject the dev banner.");
  }
  return html
    .replace("<head>", '<head>\n    <meta name="robots" content="noindex" />')
    .replace(/<body[^>]*>/, (bodyTag) => `${bodyTag}\n    ${banner}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(pagesDir, { recursive: true });

for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
  if (entry.name.startsWith(".") || excludedEntries.has(entry.name)) continue;
  cpSync(path.join(docsDir, entry.name), path.join(pagesDir, entry.name), { recursive: true });
}

// 404-page handling looks for 404.html at the assets root, outside the dev/ prefix.
cpSync(path.join(docsDir, "404.html"), path.join(outDir, "404.html"));

const sha = resolveGitSha();
const htmlPages = readdirSync(pagesDir).filter((name) => name.endsWith(".html"));
for (const page of htmlPages) {
  const pagePath = path.join(pagesDir, page);
  const html = readFileSync(pagePath, "utf8");
  writeFileSync(pagePath, activateDevVersion(injectDevMarkers(html, bannerHtml(sha, stableUrlFor(page)))));
}

writeFileSync(outDir + "/_redirects", "/dev/index.html /dev/ 301\n");

console.log(
  `Assembled dev docs at ${path.relative(process.cwd(), outDir)} ` +
    `(${htmlPages.length} pages annotated, source: ${sha ? `main@${sha.slice(0, 7)}` : "unknown"}).`,
);
