import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { effectivePiWebConfig } from "./src/config";

const { config } = effectivePiWebConfig();
const apiPort = config.port ?? 8504;
const docsRoot = resolve("docs");
const docsPrefix = "/site";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".xml": "application/xml; charset=utf-8",
};

type MiddlewareNext = (error?: unknown) => void;

async function serveDevDocs(request: IncomingMessage, response: ServerResponse, next: MiddlewareNext): Promise<void> {
  const requestUrl = request.url;
  if (requestUrl === undefined) {
    next();
    return;
  }

  const url = new URL(requestUrl, "http://localhost");
  if (url.pathname === docsPrefix) {
    response.statusCode = 302;
    response.setHeader("Location", `${docsPrefix}/`);
    response.end();
    return;
  }
  if (!url.pathname.startsWith(`${docsPrefix}/`)) {
    next();
    return;
  }

  const relativePath = decodeURIComponent(url.pathname.slice(docsPrefix.length + 1)) || "index.html";
  const requestedPath = relativePath.endsWith("/") ? join(relativePath, "index.html") : relativePath;
  const candidatePaths = extname(requestedPath) === "" ? [requestedPath, `${requestedPath}.html`] : [requestedPath];

  for (const candidatePath of candidatePaths) {
    const filePath = resolve(docsRoot, candidatePath);
    if (filePath !== docsRoot && !filePath.startsWith(`${docsRoot}${sep}`)) {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;

      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypes[extname(filePath)] ?? "application/octet-stream");
      response.setHeader("Cache-Control", "no-store");
      createReadStream(filePath).pipe(response);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") continue;
      next(error);
      return;
    }
  }

  response.statusCode = 404;
  response.end("Not found");
}

function devDocsPlugin(): Plugin {
  return {
    name: "pi-web-dev-docs",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void serveDevDocs(request, response, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [devDocsPlugin()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@codemirror/legacy-modes")) return "vendor-editor-legacy";
          if (id.includes("@lezer/common") || id.includes("@lezer/highlight") || id.includes("@lezer/lr")) return "vendor-editor-core";
          if (id.includes("@codemirror/lang-") || id.includes("@lezer/")) return "vendor-editor-languages";
          if (id.includes("@codemirror") || id.includes("codemirror")) return "vendor-editor-core";
          if (id.includes("@xterm")) return "vendor-terminal";
          return undefined;
        },
      },
    },
  },
  server: {
    host: true,
    port: 8505,
    strictPort: true,
    ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }),
    proxy: {
      "/api": { target: `http://localhost:${String(apiPort)}`, ws: true },
      "/pi-web-plugins": { target: `http://localhost:${String(apiPort)}` },
    },
  },
});
