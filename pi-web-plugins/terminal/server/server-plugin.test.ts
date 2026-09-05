import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JsonValue,
  PairedPluginBackendV1,
  PairedPluginChannelOpenContext,
  PairedPluginRequestContext,
  PairedPluginWorkspace,
  ProjectInput,
  ServerPluginActivationContext,
  ServerPluginNoticeInput,
} from "@jmfederico/pi-web/server-plugin-api";
import { activateTerminalPlugin, createTerminalBackend, terminalOutputFrames } from "./server-plugin.js";
import { TerminalService } from "./terminalService.js";

const services: TerminalService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

describe.skipIf(process.platform === "win32")("Terminal paired server entry", () => {
  it("derives Terminal scope from the host and prevents learned ids crossing workspaces", async () => {
    const service = trackedService();
    const backend = createTerminalBackend(service);
    const created = await backendRequest(backend, requestContext("terminal.create", { name: "Scoped shell" }));
    const terminalId = jsonString(created, "id");

    await expect(backendRequest(backend, requestContext("terminal.list", null))).resolves.toEqual([
      expect.objectContaining({ id: terminalId, cwd: process.cwd(), name: "Scoped shell" }),
    ]);
    await expect(backendRequest(backend, requestContext("terminal.list", null, "workspace-2"))).resolves.toEqual([]);
    await expect(backendRequest(backend, requestContext("terminal.close", { terminalId }, "workspace-2")))
      .rejects.toThrow("Terminal not found in this workspace");

    await expect(backendRequest(backend, requestContext("terminal.close", { terminalId }))).resolves.toEqual({ closed: true });
  });

  it("owns command-run control operations within the resolved workspace", async () => {
    const service = trackedService();
    const backend = createTerminalBackend(service);
    const runValue = await backendRequest(backend, requestContext("terminal.run", {
      origin: "tasks",
      title: "Output",
      command: "printf terminal-paired-run",
      metadata: { "pi.operation": "test" },
    }));
    const runId = jsonString(runValue, "id");

    await expect(backendRequest(backend, requestContext("terminal.get-run", { runId }, "workspace-2"))).resolves.toBeNull();
    await expect(backendRequest(backend, requestContext("terminal.list-runs", { metadata: { "pi.operation": "test" } })))
      .resolves.toEqual([expect.objectContaining({ id: runId, workspaceId: "workspace-1" })]);
    await vi.waitFor(async () => {
      await expect(backendRequest(backend, requestContext("terminal.get-run", { runId })))
        .resolves.toEqual(expect.objectContaining({ status: "succeeded", exitCode: 0 }));
    });
  });

  it("reports a private host-composed command failure without exposing the intent on the run", async () => {
    const records: ServerPluginNoticeInput[] = [];
    const activation = activateTerminalPlugin(activationContext("terminal", (input) => { records.push(input); }));
    const run = activation.requiredTerminalService.runCommand({
      origin: "core",
      projectId: "project-1",
      workspaceId: "workspace-1",
      cwd: process.cwd(),
      title: "Remove workspace",
      command: "exit 9",
      failureNotice: {
        message: "Workspace removal failed. See terminal output.",
        context: { projectId: "project-1", targetWorkspaceId: "target-workspace" },
      },
    });

    await vi.waitFor(() => {
      expect(records).toEqual([{
        severity: "error",
        message: "Workspace removal failed. See terminal output.",
        context: {
          commandRunId: run.id,
          projectId: "project-1",
          targetWorkspaceId: "target-workspace",
        },
      }]);
    });
    expect(run).not.toHaveProperty("failureNotice");
    await activation.stop?.(new AbortController().signal);
  });

  it("does not accept a failure-notice intent from the paired browser protocol", async () => {
    const records: ServerPluginNoticeInput[] = [];
    const activation = activateTerminalPlugin(activationContext("terminal", (input) => { records.push(input); }));
    const backend = activation.pairedBackend;
    if (backend === undefined) throw new Error("Expected Terminal paired backend");
    const runValue = await backendRequest(backend, requestContext("terminal.run", {
      origin: "browser",
      title: "Fail without host intent",
      command: "exit 8",
      failureNotice: {
        message: "Spoofed notice",
        context: { projectId: "project-1" },
      },
    }));
    const runId = jsonString(runValue, "id");

    await vi.waitFor(async () => {
      await expect(backendRequest(backend, requestContext("terminal.get-run", { runId })))
        .resolves.toEqual(expect.objectContaining({ status: "failed", exitCode: 8 }));
    });
    expect(records).toEqual([]);
    expect(runValue).not.toHaveProperty("failureNotice");
    await activation.stop?.(new AbortController().signal);
  });

  it("attaches a bounded JSON channel for input, resize, output, and cleanup", async () => {
    const service = trackedService();
    const backend = createTerminalBackend(service);
    const created = await backendRequest(backend, requestContext("terminal.create", {}));
    const terminalId = jsonString(created, "id");
    const sent: JsonValue[] = [];
    const controller = new AbortController();
    const openChannel = backend.openChannel?.bind(backend);
    if (openChannel === undefined) throw new Error("Expected Terminal channel contribution");
    const channel = await openChannel(channelContext({ terminalId, cols: 120, rows: 40 }, sent, controller));

    await channel.receive({ type: "input", data: "printf '__TERMINAL_PAIRED_CHANNEL__\\n'\n" }, new AbortController().signal);
    // Enter, Tab, and spaces are valid PTY input even though trimming would make
    // some of those frames empty.
    await channel.receive({ type: "input", data: "\r" }, new AbortController().signal);
    expect(() => channel.receive({ type: "input", data: "" }, new AbortController().signal))
      .toThrow("data must be a non-empty string");
    await channel.receive({ type: "resize", cols: 100.9, rows: 30.2 }, new AbortController().signal);
    await vi.waitFor(() => {
      expect(sent.some((frame) => jsonStringOrUndefined(frame, "type") === "output"
        && jsonStringOrUndefined(frame, "data")?.includes("__TERMINAL_PAIRED_CHANNEL__") === true)).toBe(true);
    });
    expect(() => channel.receive({ type: "unknown" }, new AbortController().signal))
      .toThrow("Unsupported Terminal channel frame");
    if (channel.closed === undefined) throw new Error("Expected Terminal-owned channel completion");
    await backendRequest(backend, requestContext("terminal.close", { terminalId }));
    await expect(channel.closed).resolves.toBeUndefined();

    controller.abort(new DOMException("browser disconnected", "AbortError"));
    await channel.close?.({ code: 1000, reason: "done", signal: new AbortController().signal });
    expect(() => channel.receive({ type: "input", data: "echo late\n" }, new AbortController().signal))
      .toThrow("browser disconnected");
  });

  it("fits the full worst-case escaped replay within the directional output budget", () => {
    const output = "\u0000".repeat(200_000);
    const frames = terminalOutputFrames(output, true);
    const readyBytes = Buffer.byteLength(JSON.stringify({ version: 1, kind: "ready" }), "utf8");
    const wireBytes = readyBytes + frames.reduce((total, data) => total + Buffer.byteLength(JSON.stringify({
      version: 1,
      kind: "data",
      data,
    }), "utf8"), 0);

    expect(frames.map(({ data }) => data).join("")).toBe(output);
    expect(frames).toHaveLength(20);
    expect(frames.slice(0, -1).every((frame) => frame.replayComplete === false)).toBe(true);
    expect(frames.at(-1)?.replayComplete).toBe(true);
    expect(wireBytes).toBe(1_202_007);
    expect(wireBytes).toBeLessThan(1_280 * 1024);
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThanOrEqual(60 * 1024);
    }
  });

  it("publishes the required service only for the terminal identity", async () => {
    const activation = activateTerminalPlugin(activationContext("terminal"));
    expect(activation.pairedBackend?.version).toBe(1);
    expect(typeof activation.pairedBackend?.openChannel).toBe("function");
    expect(typeof activation.requiredTerminalService.closeForCwd).toBe("function");
    expect(typeof activation.requiredTerminalService.runCommand).toBe("function");
    expect(typeof activation.requiredTerminalService.bindActivitySink).toBe("function");
    await activation.stop?.(new AbortController().signal);

    expect(() => activateTerminalPlugin(activationContext("other"))).toThrow("must activate as plugin id terminal");

    const withoutNotices = { ...activationContext("terminal") };
    Reflect.deleteProperty(withoutNotices, "notices");
    expect(() => activateTerminalPlugin(Object.freeze(withoutNotices)))
      .toThrow("requires server notice reporter version 1");
  });
});

function trackedService(): TerminalService {
  const service = new TerminalService();
  services.push(service);
  return service;
}

function backendRequest(backend: PairedPluginBackendV1, context: PairedPluginRequestContext): Promise<JsonValue> {
  return Promise.resolve().then(() => backend.request(context));
}

function requestContext(operation: string, input: JsonValue, workspaceId = "workspace-1"): PairedPluginRequestContext {
  return Object.freeze({
    project: project(),
    workspace: workspace(workspaceId),
    operation,
    input,
    signal: new AbortController().signal,
  });
}

function channelContext(
  input: JsonValue,
  sent: JsonValue[],
  controller: AbortController,
): PairedPluginChannelOpenContext {
  return Object.freeze({
    project: project(),
    workspace: workspace("workspace-1"),
    operation: "terminal.attach",
    input,
    signal: controller.signal,
    send: (frame: JsonValue) => { sent.push(frame); },
  });
}

function project(): ProjectInput {
  return Object.freeze({ id: "project-1", name: "Project", path: process.cwd() });
}

function workspace(id: string): PairedPluginWorkspace {
  return Object.freeze({
    id,
    projectId: "project-1",
    path: process.cwd(),
    label: id,
    isMain: true,
  });
}

function activationContext(
  pluginId: string,
  recordNotice: (input: ServerPluginNoticeInput) => void = () => undefined,
): ServerPluginActivationContext {
  return Object.freeze({
    apiVersion: 1,
    pluginId,
    packageRoot: process.cwd(),
    logger: Object.freeze({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
    settings: Object.freeze({}),
    notices: Object.freeze({ version: 1, record: recordNotice }),
    execFile: () => Promise.reject(new Error("not used")),
    signal: new AbortController().signal,
  });
}

function jsonString(value: JsonValue, key: string): string {
  const result = jsonStringOrUndefined(value, key);
  if (result === undefined) throw new Error(`Expected JSON string ${key}`);
  return result;
}

function jsonStringOrUndefined(value: JsonValue, key: string): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
