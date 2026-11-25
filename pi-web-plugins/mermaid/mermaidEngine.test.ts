// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidEngine, mermaidFrameDocument } from "./mermaidEngine";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const drawn = { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", width: 300, height: 120 };

function request(text: string, signal = new AbortController().signal) {
  return { text, width: 640, signal };
}

async function engineFrame() {
  await vi.waitFor(() => { expect(document.querySelector("iframe")).not.toBeNull(); });
  const frame = document.querySelector("iframe");
  const view = frame?.contentWindow;
  if (frame === null || view === null || view === undefined) throw new Error("Missing engine frame");
  const post = vi.spyOn(view, "postMessage").mockImplementation(() => undefined);
  const reply = (data: unknown, source: MessageEventSource = view) => {
    window.dispatchEvent(new MessageEvent("message", { source, data }));
  };
  reply({ type: "mermaid-ready" });
  return { frame, post, reply };
}

describe("shared Mermaid engine", () => {
  it("embeds only trusted engine code under a no-network policy and escapes script terminators", () => {
    const html = mermaidFrameDocument('const value = "</script><script>bad()</script>";');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'unsafe-inline'");
    expect(html).toContain("<\\/script>");
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
  });

  it("serves every diagram from one opaque-origin frame, one at a time, trusting only its own current reply", async () => {
    const load = vi.fn().mockResolvedValue("/* trusted engine */");
    const engine = new MermaidEngine(load);
    const first = engine.render(request("graph TD; A-->B"));
    const second = engine.render(request("graph TD; C-->D"));
    const { frame, post, reply } = await engineFrame();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).not.toContain("A-->B");
    await vi.waitFor(() => { expect(post).toHaveBeenCalledOnce(); });
    expect(post).toHaveBeenCalledWith({ type: "mermaid-render", id: 1, text: "graph TD; A-->B", width: 640 }, "*");

    reply({ type: "mermaid-rendered", id: 1, ...drawn }, window);
    reply({ type: "mermaid-rendered", id: 2, ...drawn });
    reply({ type: "mermaid-rendered", id: 1, ...drawn });
    await expect(first).resolves.toEqual(drawn);
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(2); });
    expect(post).toHaveBeenLastCalledWith({ type: "mermaid-render", id: 2, text: "graph TD; C-->D", width: 640 }, "*");
    reply({ type: "mermaid-error", id: 2 });
    await expect(second).rejects.toThrow("Mermaid could not render this source");

    const invalid = engine.render(request("graph TD; E"));
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(3); });
    reply({ type: "mermaid-rendered", id: 3, svg: "<svg/>", width: 300, height: Number.NaN });
    await expect(invalid).rejects.toThrow("Mermaid returned an invalid diagram");
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(load).toHaveBeenCalledOnce();
  });

  it("skips aborted queued diagrams and releases an aborted caller without stalling the queue", async () => {
    const engine = new MermaidEngine(() => Promise.resolve("engine"));
    const running = new AbortController();
    const queued = new AbortController();
    const first = engine.render(request("first", running.signal));
    const skipped = engine.render(request("skipped", queued.signal));
    const last = engine.render(request("last"));
    const { post, reply } = await engineFrame();
    await vi.waitFor(() => { expect(post).toHaveBeenCalledOnce(); });
    queued.abort();
    running.abort();
    await expect(first).rejects.toThrow();
    await expect(skipped).rejects.toThrow();
    await vi.waitFor(() => { expect(post).toHaveBeenCalledTimes(2); });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2, text: "last" }), "*");
    reply({ type: "mermaid-rendered", id: 1, ...drawn });
    reply({ type: "mermaid-rendered", id: 2, ...drawn });
    await expect(last).resolves.toEqual(drawn);
  });

  it("replaces a stuck engine after the timeout and releases an idle engine's memory", async () => {
    vi.useFakeTimers();
    const engine = new MermaidEngine(() => Promise.resolve("engine"), { timeoutMs: 1_000, idleMs: 5_000 });
    const stuck = engine.render(request("stuck"));
    const outcome = stuck.catch((error: unknown) => error);
    const { frame } = await engineFrame();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toEqual(new Error("Mermaid preview timed out"));
    expect(frame.isConnected).toBe(false);

    const next = engine.render(request("next"));
    const replacement = await engineFrame();
    expect(replacement.frame).not.toBe(frame);
    await vi.waitFor(() => { expect(replacement.post).toHaveBeenCalledOnce(); });
    replacement.reply({ type: "mermaid-rendered", id: 2, ...drawn });
    await expect(next).resolves.toEqual(drawn);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(replacement.frame.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(replacement.frame.isConnected).toBe(false);
  });

  it("reports loader failures, retries on the next diagram, and never attaches a frame after disposal", async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("Mermaid engine unavailable (503)"));
    const engine = new MermaidEngine(load);
    await expect(engine.render(request("one"))).rejects.toThrow("Mermaid engine unavailable (503)");

    let finishLoading: (engine: string) => void = () => { throw new Error("Not loading"); };
    load.mockReturnValueOnce(new Promise((resolve) => { finishLoading = resolve; }));
    const pending = engine.render(request("two"));
    await vi.waitFor(() => { expect(load).toHaveBeenCalledTimes(2); });
    engine.dispose();
    await expect(pending).rejects.toThrow("Mermaid engine is no longer available");
    finishLoading("engine");
    await Promise.resolve();
    expect(document.querySelector("iframe")).toBeNull();
    await expect(engine.render(request("three"))).rejects.toThrow("Mermaid engine is no longer available");
  });
});
