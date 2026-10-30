import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY, type PluginSessionLifecycleOptions } from "./pluginSessionLifecycleTypes.js";
import type { PluginSessionSelection } from "./pluginCatalogTypes.js";

const selection: PluginSessionSelection = { projectId: "project", workspaceId: "workspace", sessionId: "exact-session" };
function provider() {
  const command = () => vi.fn<(selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>>(() => Promise.resolve());
  return {
    version: 1,
    get: vi.fn(() => Promise.resolve({ sessionId: selection.sessionId, pinned: true, archived: false, privatePath: "/private/session.jsonl" })),
    pin: command(),
    unpin: command(),
    archive: command(),
    restore: command(),
    delete: command(),
  };
}

describe("public session lifecycle capability", () => {
  it("snapshots public state and forwards exact selections and cancellation to every command", async () => {
    const source = provider();
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(source);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const state = await lifecycle.get(selection, options);
    expect(state).toEqual({ sessionId: selection.sessionId, pinned: true, archived: false });
    expect(Object.isFrozen(state)).toBe(true);
    for (const command of ["pin", "unpin", "archive", "restore", "delete"] as const) {
      await lifecycle[command](selection, options);
      expect(source[command]).toHaveBeenCalledExactlyOnceWith(selection, options);
      expect(source[command].mock.calls[0]?.[0]).not.toBe(selection);
    }
  });

  it("rejects missing commands and incompatible versions before publication", () => {
    expect(() => PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse({ ...provider(), version: 2 })).toThrow("Invalid");
    expect(() => PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse({ ...provider(), delete: undefined })).toThrow("Invalid");
  });

  it("rejects path authority, invalid IDs, and mismatched state without mutating", async () => {
    const source = provider();
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(source);
    const pathSelection = { ...selection, cwd: "/elsewhere" };
    await expect(lifecycle.pin(pathSelection)).rejects.toThrow("Invalid");
    await expect(lifecycle.delete({ ...selection, sessionId: "" })).rejects.toThrow("Invalid");
    expect(source.pin).not.toHaveBeenCalled();
    expect(source.delete).not.toHaveBeenCalled();
    source.get.mockResolvedValue({ sessionId: "other", pinned: true, archived: false, privatePath: "" });
    await expect(lifecycle.get(selection)).rejects.toThrow("Invalid");
  });

  it("does not retarget a command when its caller changes the selection during admission", async () => {
    const source = provider();
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(source);
    const requested = { ...selection };
    const work = lifecycle.archive(requested);
    requested.sessionId = "replacement";
    await work;
    expect(source.archive).toHaveBeenCalledWith(selection, undefined);
  });
});
