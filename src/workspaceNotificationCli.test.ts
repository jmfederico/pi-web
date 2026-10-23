import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDaemonClientOptions, SessionDaemonRequestClient } from "./sessiond/sessionDaemonClient.js";
import { runWorkspaceNotificationCli } from "./workspaceNotificationCli.js";

function notificationClient(statusCode = 204, body = "") {
  return {
    request: vi.fn<SessionDaemonRequestClient["request"]>().mockResolvedValue({ statusCode, headers: {}, body }),
  };
}

const validArgs = ["notify", "--project", "project-1", "--plugin", "provider.example"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("workspace notification CLI", () => {
  it("posts an encoded opaque project id and only the attributed plugin body to the daemon", async () => {
    const client = notificationClient();
    const writeLine = vi.fn();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const projectId = "project / café?#%";

    await runWorkspaceNotificationCli(["notify", "--plugin=provider.example", `--project=${projectId}`], { client, writeLine });

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith(
      "POST",
      `/workspace-notifications/projects/${encodeURIComponent(projectId)}`,
      { pluginId: "provider.example" },
      expect.anything(),
    );
    expect(client.request.mock.calls[0]?.[3]?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(2_000);
    expect(writeLine).not.toHaveBeenCalled();
  });

  it("accepts the documented two-token syntax and bounded ids without trimming", async () => {
    const client = notificationClient();
    const projectId = ` ${"p".repeat(510)} `;
    const pluginId = "p".repeat(512);

    await runWorkspaceNotificationCli(["notify", "--project", projectId, "--plugin", pluginId], { client });

    expect(client.request).toHaveBeenCalledWith(
      "POST", `/workspace-notifications/projects/${encodeURIComponent(projectId)}`, { pluginId }, expect.anything(),
    );
  });

  it.each([
    { args: [], options: {} },
    { args: ["--daemon-url", "http://127.0.0.1:8510"], options: { baseUrl: "http://127.0.0.1:8510/" } },
    { args: ["--daemon-url=https://[::1]:8510/"], options: { baseUrl: "https://[::1]:8510/" } },
    { args: ["--daemon-socket", join(tmpdir(), "daemon's socket.sock")], options: { socketPath: join(tmpdir(), "daemon's socket.sock") } },
    { args: [`--daemon-socket=${join(tmpdir(), "socket with spaces.sock")}`], options: { socketPath: join(tmpdir(), "socket with spaces.sock") } },
  ])("passes explicit transport options to the client without changing the process environment: $args", async ({ args, options }) => {
    const client = notificationClient();
    const createClient = vi.fn<(options: SessionDaemonClientOptions) => SessionDaemonRequestClient>().mockReturnValue(client);
    const env = { ...process.env };

    await runWorkspaceNotificationCli([...validArgs, ...args], { createClient });

    expect(createClient).toHaveBeenCalledExactlyOnceWith(options);
    expect(client.request).toHaveBeenCalledOnce();
    expect(process.env).toEqual(env);
  });

  it.each([
    { args: [] },
    { args: ["help"] },
    { args: ["--help"] },
    { args: ["notify", "-h"] },
  ])("prints help without contacting the daemon: $args", async ({ args }) => {
    const createClient = vi.fn<(options: SessionDaemonClientOptions) => SessionDaemonRequestClient>();
    const writeLine = vi.fn();
    await runWorkspaceNotificationCli(args, { createClient, writeLine });
    expect(createClient).not.toHaveBeenCalled();
    expect(writeLine).toHaveBeenCalledWith("Usage: pi-web workspaces notify --project <projectId> --plugin <pluginId>");
  });

  it.each([
    { args: ["refresh", "--project=p", "--plugin=provider"] },
    { args: ["notify"] },
    { args: ["notify", "--project=p"] },
    { args: ["notify", "--plugin=provider"] },
    { args: ["notify", "--project"] },
    { args: ["notify", "--project", "--plugin=provider"] },
    { args: ["notify", "--project=p", "--plugin"] },
    { args: ["notify", "--project=p", "--plugin=provider", "--project", "q"] },
    { args: ["notify", "--project=p", "--plugin", "provider", "--plugin=other"] },
    { args: [...validArgs, "extra"] },
    { args: [...validArgs, "--branch", "main"] },
    { args: [...validArgs, "--restart"] },
    { args: [...validArgs, "--help"] },
    { args: ["help", "--project=p"] },
    { args: ["notify", "--", "--project=p", "--plugin=provider"] },
    { args: ["--project=p", "notify", "--plugin=provider"] },
    { args: ["notify", "--project=", "--plugin=provider"] },
    { args: ["notify", "--project=p", "--plugin="] },
    { args: ["notify", "--project=   ", "--plugin=provider"] },
    { args: ["notify", `--project=${"p".repeat(513)}`, "--plugin=provider"] },
    { args: ["notify", "--project=p", `--plugin=${"p".repeat(513)}`] },
    { args: ["notify", "--project=p", "--plugin=Provider"] },
    { args: ["notify", "--project=p", "--plugin=provider/path"] },
    { args: ["notify", "--project=p", "--plugin=provider name"] },
    { args: [...validArgs, "--daemon-url"] },
    { args: [...validArgs, "--daemon-socket"] },
    { args: [...validArgs, "--daemon-url", "--daemon-socket=daemon.sock"] },
    { args: [...validArgs, "--daemon-socket", "--daemon-url=http://127.0.0.1:8510"] },
    { args: [...validArgs, "--daemon-url="] },
    { args: [...validArgs, "--daemon-socket="] },
    { args: [...validArgs, "--daemon-url=not-a-url"] },
    { args: [...validArgs, "--daemon-url=file:///daemon.sock"] },
    { args: [...validArgs, "--daemon-url=ws://127.0.0.1:8510"] },
    { args: [...validArgs, "--daemon-url=http://127.0.0.1:8510", "--daemon-url", "http://127.0.0.1:8511"] },
    { args: [...validArgs, "--daemon-socket=daemon.sock", "--daemon-socket", "other.sock"] },
    { args: [...validArgs, "--daemon-url=http://127.0.0.1:8510", "--daemon-socket=daemon.sock"] },
  ])("rejects invalid arguments before I/O: $args", async ({ args }) => {
    const createClient = vi.fn<(options: SessionDaemonClientOptions) => SessionDaemonRequestClient>();
    const writeLine = vi.fn();
    await expect(runWorkspaceNotificationCli(args, { createClient, writeLine })).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
    expect(writeLine).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 503, 302])("does not treat HTTP %i as best-effort success", async (statusCode) => {
    const client = notificationClient(statusCode, '{"error":"notification rejected"}');
    await expect(runWorkspaceNotificationCli(validArgs, { client })).rejects.toThrow(
      `Workspace notification failed (HTTP ${String(statusCode)}): {"error":"notification rejected"}`,
    );
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("preserves connection failure for the CLI exit boundary", async () => {
    const client = notificationClient();
    const failure = new Error("connect ECONNREFUSED");
    client.request.mockRejectedValue(failure);
    await expect(runWorkspaceNotificationCli(validArgs, { client })).rejects.toBe(failure);
  });

  it("cancels a pending request at the two-second AbortSignal deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      setTimeout(() => { controller.abort(); }, ms);
      return controller.signal;
    });
    const client: SessionDaemonRequestClient = {
      request: (_method, _path, _body, options) => new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error("No notification deadline supplied");
        signal.addEventListener("abort", () => { reject(new Error("notification deadline reached")); }, { once: true });
      }),
    };

    const result = expect(runWorkspaceNotificationCli(validArgs, { client })).rejects.toThrow("notification deadline reached");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
    await result;
  });
});
