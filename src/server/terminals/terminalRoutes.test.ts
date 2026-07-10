import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { TerminalCommandRun, TerminalCommandRunFilter } from "../../shared/apiTypes.js";
import type { RunTerminalCommandOptions, TerminalInfo } from "./terminalService.js";
import { registerTerminalRoutes, type TerminalRouteService } from "./terminalRoutes.js";

let app: FastifyInstance;
let terminals: FakeTerminals;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  terminals = new FakeTerminals();
  registerTerminalRoutes(app, terminals);
  await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await app.close();
});

describe("terminal routes", () => {
  it("applies the initial socket size before attaching and replaying output", async () => {
    const socket = new WebSocket(`${serverUrl(app)}/terminals/t1/socket?cols=120.9&rows=40.2`);

    await expect(nextMessage(socket)).resolves.toBe(JSON.stringify({ type: "output", data: "replayed", replay: true }));
    expect(terminals.events).toEqual(["resize:t1:120x40", "attach:t1"]);

    socket.close();
  });

  it("closes all terminals for a cwd", async () => {
    // The route normalizes the request cwd, so the service receives the
    // resolved absolute path (drive-qualified on Windows).
    const requestCwd = resolve("/repo/worktree");
    const response = await app.inject({ method: "DELETE", url: `/terminals?cwd=${encodeURIComponent(requestCwd)}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ closed: true });
    expect(terminals.events).toEqual([`close-cwd:${requestCwd}`]);
  });

  it("routes command-run create, get, filter, cancel, and terminal continue requests", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/terminal-command-runs",
      payload: { origin: "core", projectId: "p1", workspaceId: "w1", cwd: "/repo", title: "Build", command: "npm test", metadata: { "pi.operation": "test" } },
    });

    expect(createResponse.statusCode).toBe(200);
    const createdRun = createResponse.json<TerminalCommandRun>();
    expect(createdRun).toMatchObject({ id: "run1", terminalId: "t-run", status: "running" });

    const getResponse = await app.inject({ method: "GET", url: "/terminal-command-runs/run1" });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json<TerminalCommandRun>()).toEqual(createdRun);

    const missingGetResponse = await app.inject({ method: "GET", url: "/terminal-command-runs/missing" });
    expect(missingGetResponse.statusCode).toBe(404);
    expect(missingGetResponse.json()).toEqual({ error: "Terminal command run not found" });

    const listResponse = await app.inject({ method: "GET", url: `/terminal-command-runs?projectId=p1&statuses=running&metadata=${encodeURIComponent(JSON.stringify({ "pi.operation": "test" }))}` });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<TerminalCommandRun[]>()).toHaveLength(1);
    expect(terminals.filters).toEqual([{ projectId: "p1", statuses: ["running"], metadata: { "pi.operation": "test" } }]);

    const cancelResponse = await app.inject({ method: "POST", url: "/terminal-command-runs/run1/cancel" });
    expect(cancelResponse.statusCode).toBe(200);
    expect(terminals.events).toContain("cancel:run1");

    const continueResponse = await app.inject({ method: "POST", url: "/terminals/t-run/continue" });
    expect(continueResponse.statusCode).toBe(200);
    expect(terminals.events).toContain("continue:t-run");
  });

  it("rejects invalid command-run filter and metadata queries", async () => {
    const invalidStatusResponse = await app.inject({ method: "GET", url: "/terminal-command-runs?statuses=running,stuck" });
    expect(invalidStatusResponse.statusCode).toBe(400);
    expect(invalidStatusResponse.json()).toEqual({ error: "Invalid command run status: stuck" });

    const arrayMetadataResponse = await app.inject({ method: "GET", url: `/terminal-command-runs?metadata=${encodeURIComponent(JSON.stringify(["not", "an", "object"]))}` });
    expect(arrayMetadataResponse.statusCode).toBe(400);
    expect(arrayMetadataResponse.json()).toEqual({ error: "metadata filter must be an object" });

    const nonStringMetadataResponse = await app.inject({ method: "GET", url: `/terminal-command-runs?metadata=${encodeURIComponent(JSON.stringify({ "pi.operation": 42 }))}` });
    expect(nonStringMetadataResponse.statusCode).toBe(400);
    expect(nonStringMetadataResponse.json()).toEqual({ error: "metadata filter value must be a string: pi.operation" });

    expect(terminals.filters).toEqual([]);
  });
});

class FakeTerminals implements TerminalRouteService {
  readonly events: string[] = [];
  readonly filters: TerminalCommandRunFilter[] = [];
  private readonly commandRuns = new Map<string, TerminalCommandRun>();

  list(cwd: string): TerminalInfo[] {
    void cwd;
    return [];
  }

  create(options: { cwd: string; name?: string; cols?: number; rows?: number }): TerminalInfo {
    return {
      id: "t1",
      cwd: options.cwd,
      name: options.name ?? "Shell 1",
      createdAt: "2026-05-13T00:00:00.000Z",
      exited: false,
    };
  }

  closeForCwd(cwd: string): void {
    this.events.push(`close-cwd:${cwd}`);
  }

  close(id: string): void {
    this.events.push(`close:${id}`);
  }

  attach(id: string, handlers: { output: (data: string, replay: boolean) => void; exit: (exitCode: number | undefined) => void }): () => void {
    this.events.push(`attach:${id}`);
    handlers.output("replayed", true);
    return () => {
      this.events.push(`detach:${id}`);
    };
  }

  write(id: string, data: string): void {
    this.events.push(`write:${id}:${data}`);
  }

  resize(id: string, cols: number, rows: number): void {
    this.events.push(`resize:${id}:${String(cols)}x${String(rows)}`);
  }

  continue(id: string): TerminalInfo {
    this.events.push(`continue:${id}`);
    return { id, cwd: "/repo", name: "Shell 1", createdAt: "2026-05-13T00:00:00.000Z", exited: false };
  }

  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun {
    const run: TerminalCommandRun = {
      id: "run1",
      origin: options.origin,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      terminalId: "t-run",
      title: options.title,
      command: options.command,
      status: "running",
      createdAt: "2026-05-13T00:00:00.000Z",
      metadata: routeMetadata(options.metadata),
    };
    this.commandRuns.set(run.id, run);
    return run;
  }

  listCommandRuns(filter: TerminalCommandRunFilter = {}): TerminalCommandRun[] {
    this.filters.push(filter);
    return [...this.commandRuns.values()];
  }

  getCommandRun(runId: string): TerminalCommandRun | undefined {
    return this.commandRuns.get(runId);
  }

  cancelCommandRun(runId: string): TerminalCommandRun {
    const run = this.commandRuns.get(runId);
    if (run === undefined) throw new Error("Terminal command run not found");
    this.events.push(`cancel:${runId}`);
    return run;
  }
}

function routeMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function serverUrl(instance: FastifyInstance): string {
  const address = instance.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${String(address.port)}`;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(rawDataToString(data));
    });
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
