import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createWorkspaceNotificationCommandFactory } from "./workspaceNotificationCommand.js";

const distributionRoot = join(tmpdir(), "pi web", "dist");
const productionModule = pathToFileURL(join(distributionRoot, "server", "workspaces", "workspaceNotificationCommand.js")).href;

describe("attributed workspace notification commands", () => {
  it("invokes Node and the compiled lightweight CLI with an explicit socket, without shell quoting", () => {
    const nodeExecutable = join(tmpdir(), "node with spaces", "bin", process.platform === "win32" ? "node.exe" : "node");
    const cwd = join(tmpdir(), "project checkout");
    const forPlugin = createWorkspaceNotificationCommandFactory({
      moduleUrl: productionModule,
      nodeExecutable,
      cwd,
      env: {
        PI_WEB_DATA_DIR: "state dir",
        PI_WEB_CONFIG: "config's settings.json",
        PI_WEB_SESSIOND_SOCKET: join("socket dir", "daemon.sock"),
        PI_WEB_SESSIOND_URL: "http://gateway.invalid:8999",
      },
    });
    const notifications = forPlugin("provider.example");
    const argv = notifications.command("--project / with 'quotes'");

    expect(argv).toEqual([
      nodeExecutable,
      join(distributionRoot, "workspaceNotificationCli.js"),
      "notify", `--daemon-socket=${join(cwd, "socket dir", "daemon.sock")}`,
      "--project=--project / with 'quotes'", "--plugin=provider.example",
    ]);
    expect(Object.isFrozen(notifications)).toBe(true);
    expect(Object.isFrozen(argv)).toBe(true);
    expect(forPlugin("other.provider").command("another-project").at(-1)).toBe("--plugin=other.provider");
  });

  it("resolves the source CLI and tsx import relative to its module, without a dist prerequisite", () => {
    // This nonexistent layout still resolves dependencies from this checkout,
    // and models a development source root containing spaces.
    const moduleUrl = new URL("./source with spaces/server/workspaces/workspaceNotificationCommand.ts", import.meta.url).href;
    const cwd = join(tmpdir(), "daemon source cwd");
    const argv = createWorkspaceNotificationCommandFactory({ moduleUrl, env: {}, cwd })("provider").command("p");
    const loader = pathToFileURL(createRequire(moduleUrl).resolve("tsx/esm")).href;

    expect(argv).toEqual([
      process.execPath, "--import", loader,
      fileURLToPath(new URL("../../workspaceNotificationCli.ts", moduleUrl)),
      "notify", `--daemon-socket=${join(homedir(), ".pi-web", "sessiond.sock")}`,
      "--project=p", "--plugin=provider",
    ]);
    expect(argv).not.toContain("tsx"); // A bare import would be resolved in the hook's cwd.
  });

  it("captures the default socket and relative data paths before the environment changes", () => {
    const cwd = join(tmpdir(), "daemon cwd");
    const env: NodeJS.ProcessEnv = { PI_WEB_DATA_DIR: "state" };
    const forPlugin = createWorkspaceNotificationCommandFactory({ moduleUrl: productionModule, env, cwd });
    env["PI_WEB_DATA_DIR"] = join(tmpdir(), "other instance");
    env["PI_WEB_SESSIOND_SOCKET"] = join(tmpdir(), "other.sock");
    env["PI_WEB_SESSIOND_PORT"] = "9999";
    env["PI_WEB_SESSIOND_URL"] = "http://another.invalid";

    expect(forPlugin("provider").command("p")).toContain(`--daemon-socket=${join(cwd, "state", "sessiond.sock")}`);
    const defaults = createWorkspaceNotificationCommandFactory({ moduleUrl: productionModule, env: {} })("provider");
    expect(defaults.command("p")).toContain(`--daemon-socket=${join(homedir(), ".pi-web", "sessiond.sock")}`);
  });

  it.each([
    { host: undefined, url: "http://127.0.0.1:8510/" },
    { host: "", url: "http://127.0.0.1:8510/" },
    { host: "0.0.0.0", url: "http://127.0.0.1:8510/" },
    { host: "::", url: "http://[::1]:8510/" },
    { host: "[::]", url: "http://[::1]:8510/" },
    { host: "::1", url: "http://[::1]:8510/" },
    { host: "192.0.2.10", url: "http://192.0.2.10:8510/" },
  ])("captures the daemon TCP listener, not a gateway URL: $host", ({ host, url }) => {
    const env: NodeJS.ProcessEnv = {
      PI_WEB_SESSIOND_PORT: "8510",
      PI_WEB_SESSIOND_URL: "https://gateway.invalid/pi-web",
      ...(host === undefined ? {} : { PI_WEB_SESSIOND_HOST: host }),
    };
    const forPlugin = createWorkspaceNotificationCommandFactory({ moduleUrl: productionModule, env });
    env["PI_WEB_SESSIOND_PORT"] = "9999";
    env["PI_WEB_SESSIOND_HOST"] = "another.invalid";
    expect(forPlugin("provider").command("p")).toEqual([
      process.execPath, join(distributionRoot, "workspaceNotificationCli.js"),
      "notify", `--daemon-url=${url}`, "--project=p", "--plugin=provider",
    ]);
  });

  it("waits for an ephemeral TCP listener and then targets its actual bound port", () => {
    const listener: { port?: number } = {};
    const env: NodeJS.ProcessEnv = { PI_WEB_SESSIOND_PORT: "0" };
    const notifications = createWorkspaceNotificationCommandFactory({
      moduleUrl: productionModule, env, listeningPort: () => listener.port,
    })("provider");
    expect(notifications.command("p")).toEqual([]);
    env["PI_WEB_SESSIOND_HOST"] = "another.invalid";
    listener.port = 8512;
    expect(notifications.command("p")).toContain("--daemon-url=http://127.0.0.1:8512/");
    expect(env["PI_WEB_SESSIOND_PORT"]).toBe("0");
  });

  it.each(["65536", "NaN", "-1", "1.5"])("fails closed for an unusable fixed daemon port: %s", (port) => {
    expect(() => createWorkspaceNotificationCommandFactory({
      moduleUrl: productionModule, env: { PI_WEB_SESSIOND_PORT: port },
    })).toThrow("daemon port");
  });

  it("validates plugin attribution at creation and project ids before generating argv", () => {
    const forPlugin = createWorkspaceNotificationCommandFactory({ moduleUrl: productionModule, env: {} });
    expect(() => forPlugin("bad/plugin")).toThrow("plugin id");
    expect(() => forPlugin("provider").command(" ")).toThrow("project id");
  });
});

// Real subprocesses prove the source launch plan works from an unrelated cwd,
// that explicit transport overrides beat inherited addresses, and that the
// lightweight CLI turns a daemon rejection into an observable nonzero exit.
describe.each(["socket", "http"])("notification source CLI %s transport", (transport) => {
  it.skipIf(transport === "socket" && process.platform === "win32").each([202, 503])("routes with HTTP %i", async (statusCode) => {
    const dir = await mkdtemp(join(tmpdir(), "pi notify "));
    const socket = join(dir, "daemon socket.sock");
    const received: { method: string | undefined; url: string | undefined; body: string }[] = [];
    const server = createServer((request, reply) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        received.push({ method: request.method, url: request.url, body });
        reply.writeHead(statusCode, { "content-type": "application/json" });
        reply.end(statusCode === 202 ? "{}" : '{"error":"provider unavailable"}');
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (transport === "socket") server.listen(socket, resolve);
        else server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      const env: NodeJS.ProcessEnv = {
        PI_WEB_DATA_DIR: dir,
        PI_WEB_CONFIG: join(dir, "config.json"),
        // This client-only URL deliberately differs from our listener.
        PI_WEB_SESSIOND_URL: "http://gateway.invalid:8999",
        ...(typeof address === "object" && address !== null
          ? { PI_WEB_SESSIOND_HOST: "127.0.0.1", PI_WEB_SESSIOND_PORT: String(address.port) }
          : { PI_WEB_SESSIOND_SOCKET: "daemon socket.sock" }),
      };
      const projectId = "--opaque / café?#%";
      const argv = createWorkspaceNotificationCommandFactory({ env, cwd: dir })("provider.example").command(projectId);
      const result = await runCommand(argv, tmpdir());

      expect(received).toEqual([{
        method: "POST",
        url: `/workspace-notifications/projects/${encodeURIComponent(projectId)}`,
        body: JSON.stringify({ pluginId: "provider.example" }),
      }]);
      expect(result.code).toBe(statusCode === 202 ? 0 : 1);
      expect(result.stdout).toBe("");
      if (statusCode === 202) expect(result.stderr).toBe("");
      else {
        expect(result.stderr).toContain("HTTP 503");
        expect(result.stderr).toContain("provider unavailable");
      }
    } finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error); }); });
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

function runCommand(argv: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [file, ...args] = argv;
  if (file === undefined) throw new Error("Missing notification executable");
  const child = spawn(file, args, {
    cwd,
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      PI_WEB_DATA_DIR: join(cwd, "wrong data"),
      PI_WEB_CONFIG: join(cwd, "wrong config.json"),
      PI_WEB_SESSIOND_SOCKET: join(cwd, "wrong daemon.sock"),
      PI_WEB_SESSIOND_HOST: "192.0.2.11",
      PI_WEB_SESSIOND_PORT: "65534",
      PI_WEB_SESSIOND_URL: "http://127.0.0.1:1",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}
