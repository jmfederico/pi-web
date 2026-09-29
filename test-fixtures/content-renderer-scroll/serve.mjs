// Isolated UI-only fixture; never connects to or starts a session daemon.
// npm run build:plugins
// node test-fixtures/content-renderer-scroll/serve.mjs
// playwright-cli -s=scroll open http://127.0.0.1:8517/test-fixtures/content-renderer-scroll/
// playwright-cli -s=scroll run-code --filename=test-fixtures/content-renderer-scroll/check.browser.js
// Append ?demo to the URL to smoke-test the ignored local complex Mermaid demo.
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  server: { host: "127.0.0.1", port: 8517, strictPort: true },
});
await server.listen();
server.printUrls();
