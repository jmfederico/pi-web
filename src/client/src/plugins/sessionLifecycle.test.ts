import { describe, expect, it, vi } from "vitest";
import { HttpRequestError } from "../api/http";
import { createPluginSessionLifecycle, type PluginSessionLifecycleRequester } from "./sessionLifecycle";

const selection = { projectId: "p/a%", workspaceId: "w/b?", sessionId: "s/c#" };
const state = { sessionId: selection.sessionId, pinned: true, archived: false };
const base = "api/machines/remote%2Fa%25/plugin-sessions/projects/p%2Fa%25/workspaces/w%2Fb%3F/sessions/s%2Fc%23";

describe("machine-bound plugin session lifecycle", () => {
  it("encodes explicit targets once and sends every lifecycle method without selection or navigation", async () => {
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.resolve({ ...state, privatePath: "/secret" }));
    const sessions = createPluginSessionLifecycle("remote/a%", undefined, requester);
    expect(await sessions.get(selection)).toEqual(state);
    for (const operation of ["pin", "unpin", "archive", "restore", "delete"] as const) {
      await expect(sessions[operation](selection)).resolves.toBeUndefined();
    }
    expect(requester.mock.calls).toEqual([
      [base, { method: "GET", cache: "no-store" }],
      ...["pin", "unpin", "archive", "restore"].map((operation) => [`${base}/${operation}`, { method: "POST", cache: "no-store" }]),
      [base, { method: "DELETE", cache: "no-store" }],
    ]);
    expect(sessions.machineId).toBe("remote/a%");
    expect(Object.isFrozen(sessions)).toBe(true);
  });

  it("rejects invalid scope before transport and does not substitute host authority", async () => {
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.resolve({ ...state, sessionId: "other" }));
    const sessions = createPluginSessionLifecycle("remote/a%", undefined, requester);
    await expect(sessions.pin({ ...selection, workspaceId: "" })).rejects.toThrow();
    expect(requester).not.toHaveBeenCalled();
    await expect(sessions.get(selection)).rejects.toThrow();
    expect(requester).toHaveBeenCalledExactlyOnceWith(base, { method: "GET", cache: "no-store" });
    expect(() => createPluginSessionLifecycle("")).toThrow();
  });

  it("combines caller cancellation with lifetime revocation for retained operations", async () => {
    const lifetime = new AbortController();
    const caller = new AbortController();
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.resolve(state));
    const sessions = createPluginSessionLifecycle("remote", lifetime.signal, requester);
    await sessions.pin(selection, { signal: caller.signal });
    const signal = requester.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    caller.abort();
    expect(signal?.aborted).toBe(true);
    await expect(sessions.get(selection, { signal: caller.signal })).rejects.toThrow();
    await sessions.get(selection);
    const lifetimeOnly = requester.mock.calls[1]?.[1]?.signal;
    lifetime.abort();
    expect(lifetimeOnly?.aborted).toBe(true);
    await expect(sessions.archive(selection)).rejects.toThrow();
    expect(requester).toHaveBeenCalledTimes(2);
  });

  it("rejects late results after disposal even when the requester ignores cancellation", async () => {
    const lifetime = new AbortController();
    let resolve!: (value: unknown) => void;
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => new Promise((done) => { resolve = done; }));
    const sessions = createPluginSessionLifecycle("remote", lifetime.signal, requester);
    const pending = sessions.restore(selection);
    lifetime.abort();
    resolve({ ok: true });
    await expect(pending).rejects.toThrow();
  });

  it("preserves observable transport failures rather than reporting mutation success", async () => {
    const error = new HttpRequestError("Session has active work", 409);
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.reject(error));
    const sessions = createPluginSessionLifecycle("remote", undefined, requester);
    await expect(sessions.delete(selection)).rejects.toBe(error);
    expect(requester).toHaveBeenCalledTimes(1);
  });
});
