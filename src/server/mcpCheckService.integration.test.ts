import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpCheckService } from "./mcpCheckService.js";
import { expectStopped, killFixtureProcess } from "./mcpCheckProcess.testSupport.js";

let root: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  if (server !== undefined) await new Promise<void>((resolve, reject) => { server?.close((error) => { if (error) reject(error); else resolve(); }); });
  server = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Pi MCP diagnostics integration", () => {
  it.skipIf(process.platform === "win32")("cleans a separately detached resistant worker after its MCP wrapper exits during a successful check", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-web-mcp-normal-close-"));
    const pidPath = join(root, "worker.pid");
    const wrapperPidPath = join(root, "wrapper.pid");
    const worker = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const source = `
      require('node:fs').writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {detached: true, stdio: ['ignore', 'pipe', 'ignore']});
      const ready = new Promise(resolve => child.stdout.once('data', resolve));
      const lines = require('node:readline').createInterface({input: process.stdin});
      lines.on('line', async line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        await ready;
        const result = message.method === 'initialize'
          ? {protocolVersion: '2025-11-25', capabilities: {tools: {}}, serverInfo: {name: 'wrapper', version: '1'}}
          : {tools: []};
        process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\\n');
      });
      process.stdin.on('end', () => process.exit(0));
    `;
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { wrapper: { command: process.execPath, args: ["-e", source] } } }));
    let pid: number | undefined;
    try {
      const response = await new McpCheckService({ agentDir: root }).check();
      expect(response.servers).toEqual([{ name: "wrapper", scope: "user", state: "connected", tools: [] }]);
      pid = Number(await readFile(pidPath, "utf8"));
      const wrapperPid = Number(await readFile(wrapperPidPath, "utf8"));
      await vi.waitFor(async () => {
        await expectStopped(wrapperPid);
        if (pid === undefined) throw new Error("No worker pid");
        await expectStopped(pid);
      }, { timeout: 5_000 });
    } finally {
      await killFixtureProcess(pidPath);
      await killFixtureProcess(wrapperPidPath);
    }
  }, 15_000);

  it.skipIf(process.platform === "win32")("stops a separately detached stdio server when a check is cancelled", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-web-mcp-cancel-"));
    const pidPath = join(root, "server.pid");
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { hanging: {
      command: process.execPath,
      args: ["-e", `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`],
    } } }));
    const controller = new AbortController();
    const outcome = new McpCheckService({ agentDir: root }).check(undefined, controller.signal).catch((error: unknown) => error);
    let pid: number | undefined;
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(pidPath, "utf8")); }, { timeout: 5_000 });
      controller.abort(new Error("cancel check"));
      expect(await outcome).toBeInstanceOf(Error);
      await vi.waitFor(async () => {
        if (pid === undefined) throw new Error("No MCP process pid");
        await expectStopped(pid);
      }, { timeout: 5_000 });
    } finally {
      controller.abort();
      await outcome;
      await killFixtureProcess(pidPath);
    }
  }, 15_000);

  it("checks a real HTTP transport in the requested profile, returns tool names, and omits connection credentials", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-web-mcp-check-"));
    const requests: string[] = [];
    const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected test request body chunk");
        chunks.push(chunk);
      }
      const message: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof message !== "object" || message === null) { response.writeHead(400).end(); return; }
      const method: unknown = Reflect.get(message, "method");
      if (typeof method !== "string") { response.writeHead(400).end(); return; }
      const id: unknown = Reflect.get(message, "id");
      requests.push(method);
      if (id === undefined) { response.writeHead(202).end(); return; }
      const result = method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0.0" } }
        : method === "tools/list"
          ? { tools: [{ name: "find_docs", description: "Search test documents", inputSchema: { type: "object", properties: {} } }] }
          : {};
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    };
    server = createServer((request, response) => { void handleRequest(request, response); });
    await new Promise<void>((resolve) => { server?.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port");
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: `http://127.0.0.1:${String(address.port)}/mcp?token=private`, headers: { Authorization: "Bearer private" } } } }));
    const result = await new McpCheckService({ agentDir: root }).check();
    expect(result.errors).toEqual([]);
    expect(result.servers).toEqual([{ name: "docs", scope: "user", state: "connected", tools: ["find_docs"] }]);
    expect(requests).toContain("tools/list");
    expect(JSON.stringify(result)).not.toContain("private");
  }, 15_000);

  it("never executes untrusted project servers and respects saved project trust", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-web-mcp-trust-"));
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    await mkdir(profile);
    await mkdir(join(workspace, ".pi"), { recursive: true });
    const marker = join(root, "started");
    await writeFile(join(workspace, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project_tools: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1)`] } } }));
    const checker = new McpCheckService({ agentDir: profile });
    const ignored = await checker.check(workspace);
    expect(ignored.servers).toEqual([]);
    expect(ignored.note).toContain("no saved trust decision");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    new ProjectTrustStore(profile).set(workspace, true);
    const checked = await checker.check(workspace);
    expect(checked.servers).toEqual([expect.objectContaining({ name: "project_tools", scope: "project", state: "failed" })]);
    expect(await readFile(marker, "utf8")).toBe("started");
  }, 15_000);
});
