import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAgentHttpIdleTimeout,
  configureAgentHttpDispatcher,
  resolveAgentHttpIdleTimeoutMs,
  type AgentHttpDispatcherInput,
  type AppliedAgentHttpIdleTimeout,
} from "./agentHttpDispatcher.js";

/**
 * The dispatcher tests install real undici global dispatchers and talk to a
 * real local HTTP server, so every test saves and restores the global
 * dispatcher and closes everything it started.
 */
let savedDispatcher: Dispatcher;
const installedDispatchers: Dispatcher[] = [];
let servers: Server[] = [];

beforeEach(() => {
  savedDispatcher = getGlobalDispatcher();
});

afterEach(async () => {
  setGlobalDispatcher(savedDispatcher);
  await Promise.all(installedDispatchers.map((dispatcher) => dispatcher.close()));
  installedDispatchers.length = 0;
  await stopStallServers();
});

function configureAndTrack(timeoutMs: number): void {
  configureAgentHttpDispatcher(timeoutMs);
  installedDispatchers.push(getGlobalDispatcher());
}

function applyAndTrack(input: AgentHttpDispatcherInput): AppliedAgentHttpIdleTimeout {
  const applied = applyAgentHttpIdleTimeout(input);
  installedDispatchers.push(getGlobalDispatcher());
  return applied;
}

/**
 * A server that writes one chunk, stays silent for `gapMs`, then finishes
 * the body. undici enforces `bodyTimeout` on its ~500 ms fast-timer tick, so
 * gaps need to stay safely above half a second to be cut deterministically.
 */
async function startStallServer(gapMs: number): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("part-one;");
    const timer = setTimeout(() => {
      if (!response.writableEnded && !response.destroyed) {
        response.write("part-two");
        response.end();
      }
    }, gapMs);
    timer.unref();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the stall server to listen on a TCP port");
  }
  return `http://127.0.0.1:${String(address.port)}/`;
}

async function stopStallServers(): Promise<void> {
  const stopping = servers;
  servers = [];
  await Promise.all(stopping.map((server) => new Promise<void>((resolve) => {
    server.close(() => { resolve(); });
    server.closeAllConnections();
  })));
}

describe("resolveAgentHttpIdleTimeoutMs", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-web-agent-http-dispatcher-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  async function writeAgentSettings(settings: Record<string, unknown>): Promise<void> {
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
  }

  it("defaults to 300000 when the agent profile has no settings", () => {
    expect(resolveAgentHttpIdleTimeoutMs({ agentDir, cwd: agentDir })).toBe(300_000);
  });

  it("returns 0 when httpIdleTimeoutMs is 0", async () => {
    await writeAgentSettings({ httpIdleTimeoutMs: 0 });
    expect(resolveAgentHttpIdleTimeoutMs({ agentDir, cwd: agentDir })).toBe(0);
  });

  it('returns 0 when httpIdleTimeoutMs is "disabled"', async () => {
    await writeAgentSettings({ httpIdleTimeoutMs: "disabled" });
    expect(resolveAgentHttpIdleTimeoutMs({ agentDir, cwd: agentDir })).toBe(0);
  });

  it("returns an explicit numeric setting", async () => {
    await writeAgentSettings({ httpIdleTimeoutMs: 60_000 });
    expect(resolveAgentHttpIdleTimeoutMs({ agentDir, cwd: agentDir })).toBe(60_000);
  });

  it("throws when the setting value is invalid", async () => {
    await writeAgentSettings({ httpIdleTimeoutMs: "soon" });
    expect(() => resolveAgentHttpIdleTimeoutMs({ agentDir, cwd: agentDir }))
      .toThrow(/Invalid httpIdleTimeoutMs setting/);
  });
});

describe("applyAgentHttpIdleTimeout", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-web-agent-http-dispatcher-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("applies a valid setting without warning", async () => {
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ httpIdleTimeoutMs: 42_000 })}\n`, "utf8");
    expect(applyAndTrack({ agentDir, cwd: agentDir })).toEqual({ timeoutMs: 42_000 });
  });

  it("falls back to the default with a warning when the setting is invalid", async () => {
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ httpIdleTimeoutMs: -5 })}\n`, "utf8");
    const applied = applyAndTrack({ agentDir, cwd: agentDir });
    expect(applied.timeoutMs).toBe(300_000);
    expect(applied.warning).toMatch(/httpIdleTimeoutMs/);
  });
});

describe("configureAgentHttpDispatcher", () => {
  it("rejects invalid timeout values without touching the global dispatcher", () => {
    const before = getGlobalDispatcher();
    expect(() => { configureAgentHttpDispatcher(-1); }).toThrow(/Invalid HTTP idle timeout/);
    expect(() => { configureAgentHttpDispatcher(Number.NaN); }).toThrow(/Invalid HTTP idle timeout/);
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("terminates an idle body once the configured timeout elapses", async () => {
    configureAndTrack(300);
    const url = await startStallServer(1_500);
    const response = await fetch(url);
    let bodyReadFailed = false;
    let termination: unknown;
    try {
      await response.text();
    } catch (error) {
      bodyReadFailed = true;
      termination = error;
    }
    expect(bodyReadFailed).toBe(true);
    expect(termination).toBeInstanceOf(TypeError);
    if (termination instanceof TypeError) {
      expect(termination.message).toBe("terminated");
      expect(termination.cause).toMatchObject({ code: "UND_ERR_BODY_TIMEOUT" });
    }
  });

  it("keeps a gapped stream alive when the timeout is disabled", async () => {
    configureAndTrack(0);
    // The gap is longer than the enforced timeout above; only a disabled
    // timer lets the second chunk arrive.
    const url = await startStallServer(400);
    const response = await fetch(url);
    await expect(response.text()).resolves.toBe("part-one;part-two");
  });
});
