#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, "docs", "assets");
const SESSION_ID = "019ef4c0-0000-7000-8000-000000000001";
const DEMO_FILE = "docs/assets/pi-web-dev-screenshot.png";
const DEFAULT_SITE_URL = "https://pi-web.dev/";
const SCREENSHOT_THEMES = ["pi-web-dark", "pi-web-light", "paper", "graphite"];
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false },
  tablet: { width: 1024, height: 768, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};

const args = parseArgs(process.argv.slice(2));
const outputDir = resolve(args.outputDir ?? DEFAULT_OUTPUT_DIR);
const keepTemp = args.keepTemp === true;
const siteUrl = args.siteUrl ?? DEFAULT_SITE_URL;
const chromeBin = args.chromeBin ?? process.env["CHROME_BIN"] ?? findChrome();

if (chromeBin === undefined) {
  fail("Chromium was not found. Install chromium-browser/chromium or set CHROME_BIN=/path/to/chrome.");
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-web-screenshots-"));
const children = new Set();
let cleanedUp = false;

process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

async function main() {
  const pillow = spawnSync("python3", ["-c", "from PIL import Image"], { encoding: "utf8" });
  if (pillow.status !== 0) fail("Screenshot capture requires Python 3 and Pillow (python3 -m pip install Pillow).");
  const logsDir = join(tempRoot, "logs");
  const dataDir = join(tempRoot, "pi-web-data");
  const configPath = join(tempRoot, "config.json");
  const sessionDir = join(tempRoot, "sessions");
  const agentDir = join(tempRoot, "pi-agent");
  const demoProject = join(tempRoot, "pi-web");
  const projectsFile = join(dataDir, "projects.json");
  const socketPath = join(dataDir, "sessiond.sock");
  await Promise.all([
    mkdir(logsDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);

  console.log(`Temporary workspace: ${tempRoot}`);
  await cloneDemoProject(demoProject);
  await removeLegacyDemoMedia(demoProject);

  const projectId = "pi-web-demo";
  const workspaceId = createWorkspaceId(projectId, demoProject);
  await writeJson(projectsFile, {
    projects: [{ id: projectId, name: "pi-web", path: demoProject, createdAt: new Date().toISOString() }],
  });
  await writeJson(configPath, { host: "127.0.0.1", allowedHosts: true });
  await writeDemoSession(sessionDir, demoProject);

  const apiPort = await getFreePort();
  const clientPort = await getFreePort();
  const debugPort = await getFreePort();
  const env = {
    ...process.env,
    PI_WEB_DATA_DIR: dataDir,
    PI_WEB_CONFIG: configPath,
    PI_WEB_PROJECTS_FILE: projectsFile,
    PI_WEB_SESSIOND_SOCKET: socketPath,
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_PORT: String(apiPort),
    PI_WEB_ALLOWED_HOSTS: "true",
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
  };

  const tsxBin = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const viteBin = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  assertExecutable(tsxBin, "Run npm install before capturing screenshots.");
  assertExecutable(viteBin, "Run npm install before capturing screenshots.");

  console.log("Starting isolated PI WEB session daemon, API server, and Vite client…");
  startChild("sessiond", tsxBin, ["src/server/sessiond.ts"], { env, cwd: REPO_ROOT, logsDir });
  await waitForFile(socketPath, 10_000);
  startChild("api", tsxBin, ["src/server/index.ts"], { env, cwd: REPO_ROOT, logsDir });
  await waitForHttp(`http://127.0.0.1:${apiPort}/api/projects`, 15_000);
  startChild("vite", viteBin, ["--host", "127.0.0.1", "--port", String(clientPort), "--strictPort", "true"], { env, cwd: REPO_ROOT, logsDir });
  await waitForHttp(`http://127.0.0.1:${clientPort}/`, 30_000);

  console.log("Starting Chromium and capturing screenshots…");
  const chrome = startChild("chromium", chromeBin, chromeArgs(debugPort, join(tempRoot, "chrome-profile")), { env, cwd: REPO_ROOT, logsDir });
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 15_000);
  const cdp = await openPage(debugPort);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await captureWebsiteScreenshot(cdp, join(demoProject, DEMO_FILE), siteUrl);

    const appUrl = new URL(`http://127.0.0.1:${clientPort}/`);
    appUrl.searchParams.set("project", projectId);
    appUrl.searchParams.set("workspace", workspaceId);
    appUrl.searchParams.set("session", SESSION_ID);
    appUrl.searchParams.set("view", "chat");

    for (const [device, viewport] of Object.entries(VIEWPORTS)) {
      const legacyPath = join(outputDir, `pi-web-${device}.png`);
      if (device === "desktop") await captureDesktop(cdp, appUrl, legacyPath);
      else await captureDefaultApp(cdp, appUrl, viewport, legacyPath);
      // Prepare each device's scene once so only its theme changes between captures.
      for (const theme of SCREENSHOT_THEMES) {
        await selectTheme(cdp, theme);
        await capturePng(cdp, join(outputDir, `pi-web-${device}-${theme}.png`));
      }
    }
  } finally {
    cdp.close();
    chrome.kill("SIGTERM");
  }

  for (const device of Object.keys(VIEWPORTS)) {
    const animationPath = join(outputDir, device === "desktop" ? "pi-web-themes.gif" : `pi-web-${device}-themes.gif`);
    createThemeAnimation(device, animationPath);
    console.log(`Wrote ${animationPath}`);
    for (const theme of SCREENSHOT_THEMES) console.log(`Wrote ${join(outputDir, `pi-web-${device}-${theme}.png`)}`);
    console.log(`Wrote ${join(outputDir, `pi-web-${device}.png`)}`);
  }
  if (keepTemp) console.log(`Kept temporary workspace: ${tempRoot}`);
}

async function captureWebsiteScreenshot(cdp, outputPath, url) {
  await mkdir(dirname(outputPath), { recursive: true });
  await setViewport(cdp, { width: 1280, height: 720, mobile: false });
  try {
    await navigate(cdp, url, 20_000);
    await waitForDocumentFonts(cdp);
    await sleep(3500);
    await capturePng(cdp, outputPath);
  } catch (error) {
    console.warn(`Unable to capture ${url}; using a local fallback image. ${error instanceof Error ? error.message : String(error)}`);
    const fallback = `data:text/html,${encodeURIComponent(fallbackWebsiteHtml(url))}`;
    await navigate(cdp, fallback, 10_000);
    await sleep(300);
    await capturePng(cdp, outputPath);
  }
}

async function captureDesktop(cdp, appUrl, outputPath) {
  await setViewport(cdp, VIEWPORTS.desktop);
  await navigate(cdp, appUrl.href, 15_000);
  await waitForApp(cdp);
  await selectPreviewImage(cdp);
  await selectTheme(cdp, "pi-web-dark");
  await sleep(500);
  await capturePng(cdp, outputPath);
}

async function captureDefaultApp(cdp, appUrl, viewport, outputPath) {
  await setViewport(cdp, viewport);
  await navigate(cdp, appUrl.href, 15_000);
  await waitForApp(cdp);
  await selectTheme(cdp, "pi-web-dark");
  await capturePng(cdp, outputPath);
}

async function selectTheme(cdp, theme) {
  const css = await readFile(join(REPO_ROOT, "src/client/src/plugins/themes", `${theme}.css`), "utf8");
  const background = css.match(/--pi-bg:\s*([^;]+);/)?.[1]?.trim();
  if (background === undefined) throw new Error(`Theme ${theme} has no background token`);
  await evaluate(cdp, `(async () => {
    const app = document.querySelector("pi-web-app");
    const themeId = ${JSON.stringify(`themes:${theme}`)};
    if (typeof app?.pickTheme !== "function") throw new Error("Theme selection is unavailable");
    app.pickTheme({ themeId, auto: false });
    await app.updateComplete;
    // Theme sheets are fetched asynchronously and applied to multiple shadow roots.
    const deadline = Date.now() + 10000;
    while (getComputedStyle(document.documentElement).getPropertyValue("--pi-bg").trim() !== ${JSON.stringify(background)} || app.activeThemeId !== themeId) {
      if (Date.now() > deadline) throw new Error("Timed out applying " + themeId);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await document.fonts.ready;
  })()`);
  await sleep(700);
}

function createThemeAnimation(device, outputPath) {
  const result = spawnSync("python3", ["-c", `
import sys
from PIL import Image
frames = [Image.open(path).convert("RGB") for path in sys.argv[2:]]
frames[0].save(sys.argv[1], save_all=True, append_images=frames[1:], duration=3000, loop=0, disposal=2)
`, outputPath, ...SCREENSHOT_THEMES.map(theme => join(outputDir, `pi-web-${device}-${theme}.png`))], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Unable to generate the ${device} animation. Install Python 3 and Pillow (python3 -m pip install Pillow). ${result.error?.message ?? result.stderr}`);
  }
}

async function selectPreviewImage(cdp) {
  await evaluate(cdp, `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const app = document.querySelector("pi-web-app");
    if (!app) throw new Error("pi-web-app not found");
    const pluginDeadline = Date.now() + 15000;
    let filesTool;
    while (!(filesTool = app.plugins.getWorkspacePanels().find(panel => panel.id.endsWith(":workspace.files")))) {
      if (Date.now() > pluginDeadline) throw new Error("Timed out waiting for Files plugin activation");
      await sleep(100);
    }
    if (typeof app.openWorkspaceTool !== "function") throw new Error("Workspace tool selection is unavailable");
    const queryDeep = (root, selector) => {
      const match = root.querySelector(selector);
      if (match) return match;
      for (const element of root.querySelectorAll("*")) {
        const nested = element.shadowRoot && queryDeep(element.shadowRoot, selector);
        if (nested) return nested;
      }
    };
    app.openWorkspaceTool(filesTool.id);
    await app.updateComplete;
    const deadline = Date.now() + 10000;
    let panel;
    while (!(panel = queryDeep(app.shadowRoot, "pi-web-files-panel"))?.runtime || !panel.context) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for Files plugin");
      await sleep(100);
    }
    await panel.runtime.refreshFiles(panel.context);
    await panel.runtime.expandDir(panel.context, "docs");
    await panel.runtime.expandDir(panel.context, "docs/assets");
    await panel.runtime.selectFile(panel.context, ${JSON.stringify(DEMO_FILE)});
    await panel.updateComplete;
    while (Date.now() < deadline) {
      const image = queryDeep(panel.shadowRoot, ".image-preview img");
      if (image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0) return true;
      await sleep(100);
    }
    throw new Error("Timed out waiting for image preview");
  })()`);
}

async function waitForApp(cdp) {
  await evaluate(cdp, `new Promise((resolve, reject) => {
    const start = Date.now();
    const visibleText = () => {
      const app = document.querySelector("pi-web-app");
      const appRoot = app?.shadowRoot;
      const chatRoot = appRoot?.querySelector("chat-view")?.shadowRoot;
      return [appRoot?.textContent ?? "", chatRoot?.textContent ?? ""].join("\\n");
    };
    const check = () => {
      const text = visibleText();
      if (text.includes("Showing messages") && text.includes("assistant")) {
        resolve(true);
        return;
      }
      if (Date.now() - start > 15000) {
        reject(new Error("PI WEB app did not restore the seeded session in time. Visible text: " + visibleText()));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  })`);
}

async function waitForDocumentFonts(cdp) {
  try {
    await evaluate(cdp, `document.fonts?.ready?.then(() => true) ?? true`);
  } catch {
    // Font loading is best-effort; screenshots still work with fallback fonts.
  }
}

async function navigate(cdp, url, timeoutMs) {
  const loaded = cdp.waitForEvent("Page.loadEventFired", timeoutMs).catch(() => undefined);
  await cdp.send("Page.navigate", { url });
  await loaded;
}

async function setViewport(cdp, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
}

async function capturePng(cdp, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(outputPath, Buffer.from(data, "base64"));
}

async function cloneDemoProject(target) {
  const result = spawnSync("git", ["clone", "--quiet", "--local", "--no-hardlinks", REPO_ROOT, target], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git clone failed:\n${result.stderr || result.stdout}`);
}

async function removeLegacyDemoMedia(projectRoot) {
  await Promise.all([
    rm(join(projectRoot, "docs", "assets", "pi-web-demo.gif"), { force: true }),
    rm(join(projectRoot, "docs", "assets", "pi-web-demo.webm"), { force: true }),
    rm(join(projectRoot, "docs", "assets", "pi-web-demo-flow.gif"), { force: true }),
  ]);
}

async function writeDemoSession(sessionDir, cwd) {
  const now = new Date();
  const timestamp = now.toISOString();
  const file = join(sessionDir, `${timestamp.replaceAll(":", "-")}_${SESSION_ID}.jsonl`);
  const ms = now.getTime();
  const entries = [
    { type: "session", version: 3, id: SESSION_ID, timestamp, cwd },
    { type: "model_change", id: "10000001", parentId: null, timestamp: iso(ms + 100), provider: "openai-codex", modelId: "gpt-5.5" },
    { type: "thinking_level_change", id: "10000002", parentId: "10000001", timestamp: iso(ms + 200), thinkingLevel: "off" },
    {
      type: "message",
      id: "10000003",
      parentId: "10000002",
      timestamp: iso(ms + 1000),
      message: {
        role: "user",
        content: [{ type: "text", text: "Take a screenshot of https://pi-web.dev, save it under docs/assets, and tell me where I can preview it." }],
        timestamp: ms + 1000,
      },
    },
    { type: "session_info", id: "10000004", parentId: "10000003", timestamp: iso(ms + 1100), name: "Screenshot pi-web.dev" },
    {
      type: "message",
      id: "10000005",
      parentId: "10000004",
      timestamp: iso(ms + 2000),
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_demo_screenshot",
          name: "bash",
          arguments: { command: `capture-browser-screenshot https://pi-web.dev ${DEMO_FILE}` },
        }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.5",
        usage: zeroUsage(),
        stopReason: "toolUse",
        timestamp: ms + 2000,
      },
    },
    {
      type: "message",
      id: "10000006",
      parentId: "10000005",
      timestamp: iso(ms + 3000),
      message: {
        role: "toolResult",
        toolCallId: "call_demo_screenshot",
        toolName: "bash",
        content: [{ type: "text", text: `Saved screenshot to ${DEMO_FILE}` }],
        isError: false,
        timestamp: ms + 3000,
      },
    },
    {
      type: "message",
      id: "10000007",
      parentId: "10000006",
      timestamp: iso(ms + 4000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Done — I saved the screenshot at \`${DEMO_FILE}\`. Open the Files panel to preview it.` }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.5",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: ms + 4000,
      },
    },
  ];
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function fallbackWebsiteHtml(url) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#07121f,#2b174c);color:#f8fafc;font:24px system-ui,sans-serif}
    main{width:min(900px,calc(100vw - 80px));padding:56px;border:1px solid rgba(255,255,255,.22);border-radius:28px;background:rgba(10,16,32,.72);box-shadow:0 24px 80px rgba(0,0,0,.35)}
    h1{margin:0 0 14px;font-size:64px;letter-spacing:-.06em}.eyebrow{color:#c084fc;text-transform:uppercase;letter-spacing:.16em;font-size:14px;font-weight:700}p{line-height:1.5;color:#dbeafe}
  </style></head><body><main><div class="eyebrow">PI WEB</div><h1>pi-web.dev</h1><p>Fallback screenshot for ${escapeHtml(url)}.</p></main></body></html>`;
}

function chromeArgs(debugPort, userDataDir) {
  return [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "about:blank",
  ];
}

function startChild(name, command, childArgs, { env, cwd, logsDir }) {
  const logPath = join(logsDir, `${name}.log`);
  const child = spawn(command, childArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const chunks = [];
  const collect = (chunk) => {
    chunks.push(Buffer.from(chunk));
    if (chunks.length > 120) chunks.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.stdout.on("data", (chunk) => appendLog(logPath, chunk));
  child.stderr.on("data", (chunk) => appendLog(logPath, chunk));
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!cleanedUp && code !== 0 && signal === null) {
      const recent = Buffer.concat(chunks).toString("utf8").trim();
      console.error(`${name} exited with code ${code}. Recent log:\n${recent}`);
    }
  });
  return child;
}

function appendLog(path, chunk) {
  void mkdir(dirname(path), { recursive: true })
    .then(() => writeFile(path, chunk, { flag: "a" }))
    .catch(() => undefined);
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  await Promise.all([...children].map((child) => terminate(child)));
  if (!keepTemp) await rm(tempRoot, { recursive: true, force: true });
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2500).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForFile(path, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) reject(new Error("Unable to allocate a port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function openPage(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Unable to create Chromium tab: ${response.status} ${response.statusText}`);
  const info = await response.json();
  return CDP.connect(info.webSocketDebuggerUrl);
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails !== undefined) throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
  return response.result?.value;
}

class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const cdp = new CDP(ws);
      ws.addEventListener("open", () => resolve(cdp), { once: true });
      ws.addEventListener("error", (event) => reject(event.error ?? new Error("CDP websocket error")), { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanupListener();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (params) => {
        cleanupListener();
        resolve(params);
      };
      const cleanupListener = () => {
        clearTimeout(timer);
        const listeners = this.listeners.get(method) ?? [];
        this.listeners.set(method, listeners.filter((candidate) => candidate !== listener));
      };
      this.listeners.set(method, [...this.listeners.get(method) ?? [], listener]);
    });
  }

  close() {
    this.ws.close();
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
  }
}

function createWorkspaceId(projectId, path) {
  return createHash("sha1").update(`${projectId}:${path}`).digest("hex").slice(0, 12);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/capture-screenshots.mjs [--output-dir docs/assets] [--site-url https://pi-web.dev/] [--keep-temp] [--chrome-bin /path/to/chrome]\n\nCaptures desktop, tablet, and mobile scenes each in PI WEB Dark, PI WEB Light, Paper, and Graphite, plus legacy dark screenshots and a hard-cut GIF for each device (3 seconds per theme). Requires Chromium, Python 3, and Pillow. Uses an isolated temporary instance.`);
      process.exit(0);
    }
    if (arg === "--keep-temp") {
      parsed.keepTemp = true;
      continue;
    }
    if (arg === "--output-dir") {
      parsed.outputDir = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      parsed.outputDir = arg.slice("--output-dir=".length);
      continue;
    }
    if (arg === "--site-url") {
      parsed.siteUrl = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg.startsWith("--site-url=")) {
      parsed.siteUrl = arg.slice("--site-url=".length);
      continue;
    }
    if (arg === "--chrome-bin") {
      parsed.chromeBin = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg.startsWith("--chrome-bin=")) {
      parsed.chromeBin = arg.slice("--chrome-bin=".length);
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function findChrome() {
  return findExecutable(["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]);
}

function findExecutable(candidates) {
  for (const candidate of candidates) {
    const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(candidate)}`], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim().split("\n")[0];
  }
  return undefined;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertExecutable(path, message) {
  if (!existsSync(path)) fail(`${path} was not found. ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  await main();
} finally {
  await cleanup();
}
