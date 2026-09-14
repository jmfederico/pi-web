---
"@jmfederico/pi-web": patch
---

Make the web/API process's client serving an explicit startup decision instead of a source-tree probe: packaged mode serves only the built `dist/client` and fails startup with an actionable error when the build output is missing, so raw `src/client` source HTML (the `%BASE_URL%` blank page) can never be served. Development stacks (`npm run dev:*`, the Docker `--dev` stack) now declare the local browser entrypoint explicitly through `PI_WEB_BROWSER_URL` pointing at the Vite dev server; the API process serves no client there and answers non-API requests with a pointer to that URL. Safe Tunnel's default local target follows the same entrypoint — the Vite listener in development, the API listener (custom ports honored) in packaged mode.
