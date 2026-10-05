// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSessionActivity, type ActivityLoader } from "./LiveSessionActivity";
import type { SessionActivitySnapshot } from "../../../shared/sessionActivity";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

function snapshot(sessionId = "one", cwd = "/repo"): SessionActivitySnapshot {
  return { version: 1, sessionId, cwd, sampledAt: "2026-10-05T00:00:00Z",
    todos: { state: "ready", value: [{ id: "1", title: "Real todo", status: "in_progress", depth: 0 }] },
    goal: { state: "ready", value: { id: "g", objective: "Real focused goal", status: "active", tasks: [{ id: "g1", title: "Goal work", status: "pending", depth: 0 }] } },
    fleet: { state: "ready", value: { totalActive: 1, omitted: 0, entries: [{ key: "opaque", agent: "Luna", model: "model", goal: "Review" }] } },
    children: { state: "ready", value: [{ sessionId: "child", cwd, status: "working" }] },
    memory: { state: "ready", value: { totalBytes: 10 * 1_073_741_824, availableBytes: 6 * 1_073_741_824, availability: "available" } },
  };
}

async function settle(view: LiveSessionActivity) { await view.updateComplete; await Promise.resolve(); await view.updateComplete; }
async function mount(load: ActivityLoader) {
  const view = new LiveSessionActivity(); view.sessionId = "one"; view.cwd = "/repo"; view.loadActivity = load;
  document.body.append(view); await settle(view); return view;
}

describe("selected-session live activity", () => {
  it("shows real goal, both task systems, both agent systems and accessible system RAM without a pressure alert", async () => {
    const view = await mount(() => Promise.resolve(snapshot()));
    expect(view.shadowRoot?.textContent).toContain("Real focused goal");
    expect(view.shadowRoot?.textContent).toContain("Real todo");
    expect(view.shadowRoot?.textContent).toContain("Goal work");
    expect(view.shadowRoot?.textContent).toContain("1 active");
    expect(view.shadowRoot?.textContent).toContain("1 working / 1 tracked");
    const meter = view.shadowRoot?.querySelector("meter");
    expect(meter?.getAttribute("aria-label")).toBe("System RAM used");
    expect(meter?.getAttribute("value")).toBe(String(4 * 1_073_741_824));
    expect(meter?.getAttribute("aria-valuetext")).toContain("6.0 GiB available");
    expect(view.shadowRoot?.textContent).toContain("Not a pressure measurement");
  });

  it("retires late replies after same-id machine/cwd changes", async () => {
    let resolveOld: ((value: SessionActivitySnapshot) => void) | undefined;
    const load = vi.fn<ActivityLoader>().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementation((session) => Promise.resolve({ ...snapshot(session.id, session.cwd), goal: { state: "ready", value: null } }));
    const view = await mount(load);
    view.cwd = "/other"; view.machineId = "remote"; await settle(view);
    resolveOld?.(snapshot()); await settle(view);
    expect(view.shadowRoot?.textContent).toContain("No focused goal");
    expect(view.shadowRoot?.textContent).not.toContain("Real focused goal");
    expect(load.mock.calls.at(-1)?.[1]).toBe("remote");
    expect(load.mock.calls[0]?.[2].signal.aborted).toBe(true);
  });

  it("rejects wrong ownership and never leaves a healthy-looking meter after read failure", async () => {
    vi.useFakeTimers();
    const load = vi.fn<ActivityLoader>().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot("wrong"));
    const view = await mount(load);
    expect(view.shadowRoot?.querySelector("meter")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000); await settle(view);
    expect(view.shadowRoot?.querySelector("meter")).toBeNull();
    expect(view.shadowRoot?.textContent).toContain("Live activity unavailable");
    view.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suspends sampling in a hidden tab and cancels all timers on detach", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const load = vi.fn<ActivityLoader>().mockResolvedValue(snapshot());
    const view = await mount(load);
    expect(load).toHaveBeenCalledOnce();
    visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
    await settle(view); expect(load).toHaveBeenCalledTimes(2);
    view.remove(); expect(vi.getTimerCount()).toBe(0);
  });
});
