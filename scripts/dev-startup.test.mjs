import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runDevelopmentWeb } from "./dev-web.mjs";
import { runDevelopmentSessiond, waitForPluginBuild } from "./dev-sessiond.mjs";

function harness() {
  const signals = new EventEmitter();
  const children = [];
  const launch = vi.fn(() => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.finish = (code) => { child.exitCode = code; child.emit("exit", code, null); };
    children.push(child);
    return child;
  });
  const stop = vi.fn(child => child.finish(0));
  return { signals, children, launch, stop, env: {} };
}

it("starts one builder, waits for publication, then starts the API without rebuilding", async () => {
  const options = harness();
  const running = runDevelopmentWeb(options);
  expect(options.launch).toHaveBeenCalledTimes(1);
  const builder = options.children[0];
  expect(options.launch.mock.calls[0][1]).toEqual(["--watch"]);
  builder.emit("message", { type: "plugin-build-ready" });
  builder.emit("message", { type: "plugin-build-ready" });
  expect(options.launch).toHaveBeenCalledTimes(2);
  expect(options.launch.mock.calls[1][1]).toEqual(["watch", "src/server/index.ts"]);
  builder.finish(1);
  expect(await running).toBe(1);
  expect(options.stop).toHaveBeenCalledWith(options.children[1]);
});

it("does not start the API when the initial build fails", async () => {
  const options = harness();
  const running = runDevelopmentWeb(options);
  options.children[0].finish(1);
  expect(await running).toBe(1);
  expect(options.launch).toHaveBeenCalledTimes(1);
});

it("stops the builder when the API exits or the web owner is stopped", async () => {
  const options = harness();
  const running = runDevelopmentWeb(options);
  options.children[0].emit("message", { type: "plugin-build-ready" });
  options.children[1].finish(1);
  expect(await running).toBe(1);
  expect(options.stop).toHaveBeenCalledWith(options.children[0]);
  const stopped = harness();
  const stopping = runDevelopmentWeb(stopped);
  stopped.signals.emit("SIGTERM");
  expect(await stopping).toBe(143);
  expect(stopped.stop).toHaveBeenCalledWith(stopped.children[0]);
});

it("starts sessiond only after build readiness without starting another builder", async () => {
  const options = harness();
  let publish;
  const wait = vi.fn(() => new Promise(resolve => { publish = resolve; }));
  const running = runDevelopmentSessiond({ ...options, wait });
  expect(options.launch).not.toHaveBeenCalled();
  publish();
  await vi.waitFor(() => expect(options.launch).toHaveBeenCalledOnce());
  expect(options.launch.mock.calls[0][0]).toBe("src/server/sessiond.ts");
  expect(options.launch.mock.calls[0][1]).toEqual([]);
  expect(options.launch.mock.calls[0][4][0]).toBe("--import");
  expect(options.launch.mock.calls[0][2]).toEqual(options.env);
  options.children[0].finish(0);
  expect(await running).toBe(0);
});

it("does not launch sessiond if stopped while readiness is resolving", async () => {
  const options = harness();
  let publish;
  const running = runDevelopmentSessiond({ ...options, wait: () => new Promise(resolve => { publish = resolve; }) });
  options.signals.emit("SIGTERM");
  publish();
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
  expect(options.launch).not.toHaveBeenCalled();
});

it("waits for the cold-start marker and reports a missing builder", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-dev-start-"));
  try {
    await expect(waitForPluginBuild({ cwd, timeoutMs: 0 })).rejects.toThrow("Plugin build not ready");
    const waiting = waitForPluginBuild({ cwd, intervalMs: 1, timeoutMs: 5_000 });
    await mkdir(join(cwd, "dist"));
    await writeFile(join(cwd, "dist", ".plugins-ready"), "ready");
    await waiting;
    const controller = new AbortController();
    controller.abort();
    await expect(waitForPluginBuild({ cwd, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("does not start sessiond after a readiness failure", async () => {
  const options = harness();
  await expect(runDevelopmentSessiond({ ...options, wait: () => Promise.reject(new Error("no build")) })).rejects.toThrow("no build");
  expect(options.launch).not.toHaveBeenCalled();
  expect(options.signals.listenerCount("SIGTERM")).toBe(0);
});
