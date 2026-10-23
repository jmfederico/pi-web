import { describe, expect, it, vi } from "vitest";
import { moveOrderedId } from "../navigationOrder";
import { NavigationOrderController, type NavigationOrderPort, type NavigationOrderScope, type NavigationOrderSnapshot } from "./navigationOrderController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const projects: NavigationOrderScope = { kind: "projects", machineId: "local" };
const remote: NavigationOrderScope = { kind: "projects", machineId: "remote" };

describe("NavigationOrderController", () => {
  it("coalesces loads and keeps late results in their own scope", async () => {
    const first = deferred<NavigationOrderSnapshot>();
    const second = deferred<NavigationOrderSnapshot>();
    const load = vi.fn((scope: NavigationOrderScope) => scope.machineId === "local" ? first.promise : second.promise);
    const controller = new NavigationOrderController({ load, save: vi.fn() });
    const a = controller.ensure(projects);
    expect(controller.ensure({ ...projects })).toBe(a);
    const b = controller.ensure(remote);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve({ ids: ["remote-project"], revision: 1 });
    await b;
    expect(controller.pending(projects)).toBe(true);
    first.resolve({ ids: ["local-project"], revision: 2 });
    await a;
    expect(controller.ids(remote)).toEqual(["remote-project"]);
    expect(controller.ids(projects)).toEqual(["local-project"]);
    expect(controller.pending(projects)).toBe(false);
  });

  it("serializes repeated moves against resulting state and updated revisions", async () => {
    const saving = deferred<NavigationOrderSnapshot>();
    const save = vi.fn<NavigationOrderPort["save"]>()
      .mockImplementationOnce(() => saving.promise)
      .mockResolvedValueOnce({ ids: ["c", "b", "a", "hidden"], revision: 3 });
    const controller = new NavigationOrderController({
      load: vi.fn().mockResolvedValue({ ids: ["a", "hidden", "b", "c"], revision: 1 }), save,
    });
    await controller.ensure(projects);
    const first = controller.mutate(projects, (ids) => moveOrderedId(ids, ["a", "b", "c"], "b", "a", "before"));
    const second = controller.mutate(projects, (ids) => moveOrderedId(ids, ["b", "a", "c"], "c", "b", "before"));
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.ids(projects)).toEqual(["a", "hidden", "b", "c"]);
    saving.resolve({ ids: ["b", "a", "hidden", "c"], revision: 2 });
    await Promise.all([first, second]);
    expect(save.mock.calls).toEqual([
      [projects, ["b", "a", "hidden", "c"], 1],
      [projects, ["c", "b", "a", "hidden"], 2],
    ]);
    expect(controller.ids(projects)).toEqual(["c", "b", "a", "hidden"]);
  });

  it.each(["conflict", "network failure"])("reports %s, refetches and never retries an overwrite", async (message) => {
    const error = new Error(message);
    const onError = vi.fn();
    const onChange = vi.fn();
    const load = vi.fn().mockResolvedValueOnce({ ids: ["a"], revision: 1 })
      .mockResolvedValueOnce({ ids: ["external", "a"], revision: 8 });
    const save = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ ids: ["external", "a", "new"], revision: 9 });
    const controller = new NavigationOrderController({ load, save }, { onError, onChange });
    await controller.ensure(projects);
    await expect(controller.mutate(projects, () => ["bad"])).rejects.toBe(error);
    expect(controller.ids(projects)).toEqual(["external", "a"]);
    expect(onError).toHaveBeenCalledWith(projects, error);
    expect(controller.pending(projects)).toBe(false);
    await controller.mutate(projects, (ids) => [...ids, "new"]);
    expect(save).toHaveBeenLastCalledWith(projects, ["external", "a", "new"], 8);
    expect(onChange).toHaveBeenCalled();
  });

  it("retries failed loads and reloads before queued writes when recovery failed", async () => {
    const failure = new Error("offline");
    const load = vi.fn().mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ ids: ["a"], revision: 1 })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ ids: ["server"], revision: 4 });
    const save = vi.fn().mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ ids: ["server", "new"], revision: 5 });
    const controller = new NavigationOrderController({ load, save });
    await expect(controller.ensure(projects)).rejects.toBe(failure);
    await controller.ensure(projects);
    await expect(controller.mutate(projects, () => ["lost"])).rejects.toBe(failure);
    await controller.mutate(projects, (ids) => [...ids, "new"]);
    expect(save).toHaveBeenLastCalledWith(projects, ["server", "new"], 4);
  });

  it("serializes explicit refresh behind a save and distinguishes workspace scopes", async () => {
    const saving = deferred<NavigationOrderSnapshot>();
    const load = vi.fn().mockResolvedValue({ ids: ["a"], revision: 0 });
    const controller = new NavigationOrderController({ load, save: () => saving.promise });
    const scope: NavigationOrderScope = { kind: "sessionPins", machineId: "local", projectId: "p", workspaceId: "w" };
    await controller.ensure(scope);
    const mutation = controller.mutate(scope, () => ["b"]);
    const refresh = controller.load(scope);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    saving.resolve({ ids: ["b"], revision: 1 });
    await mutation;
    await refresh;
    expect(load).toHaveBeenCalledTimes(2);
    expect(controller.ids({ ...scope, projectId: "other" })).toEqual([]);
    expect(controller.ids({ ...scope, workspaceId: "other" })).toEqual([]);
  });
});
