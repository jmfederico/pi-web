// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { StatusBar, statusBarWarningControlContent } from "./StatusBar";

afterEach(() => {
  document.body.replaceChildren();
});

describe("statusBarWarningControlContent", () => {
  it("provides an action label for both states while keeping only the count visible", () => {
    expect(statusBarWarningControlContent(1, true)).toEqual({
      countText: "1",
      accessibleLabel: "Minimise 1 warning",
    });
    expect(statusBarWarningControlContent(3, false)).toEqual({
      countText: "3",
      accessibleLabel: "Show 3 warnings in the warning area",
    });
  });

  it("omits the control content when there are no warnings", () => {
    expect(statusBarWarningControlContent(0, false)).toBeUndefined();
  });
});

describe("StatusBar warning toggle wiring", () => {
  it("invokes onToggleWarnings when the warning-count control is activated", async () => {
    const statusBar = new StatusBar();
    const onToggleWarnings = vi.fn();
    statusBar.status = makeStatus();
    statusBar.warningCount = 2;
    statusBar.warningsExpanded = true;
    statusBar.onToggleWarnings = onToggleWarnings;
    document.body.append(statusBar);
    await statusBar.updateComplete;

    statusBar.shadowRoot?.querySelector<HTMLButtonElement>(".warning-toggle")?.click();

    expect(onToggleWarnings).toHaveBeenCalledOnce();
  });
});

describe("StatusBar cache and context usage", () => {
  it("shows zero cache counts without deriving a hit rate when inputs are zero", async () => {
    const statusBar = await mountStatusBar(makeStatus());
    const root = statusBar.shadowRoot;

    expect(root?.textContent).toContain("cache read 0");
    expect(root?.textContent).toContain("cache write 0");
    expect(root?.querySelector("[title^='Provider-reported cumulative cache-read']")?.getAttribute("title"))
      .toContain("no hit rate is inferred");
    expect(root?.querySelector("[title^='Provider-reported cumulative cache-read']")?.getAttribute("aria-description"))
      .toContain("No hit rate is inferred");
  });

  it("keeps cache totals separate from current context and session cost", async () => {
    const statusBar = await mountStatusBar(makeStatus({
      pendingMessageCount: 2,
      tokens: { input: 12_000, output: 3_400, cacheRead: 2_500, cacheWrite: 750, total: 16_000 },
      contextUsage: { tokens: 800, contextWindow: 128_000, percent: 0.625 },
      cost: 0.12,
    }));
    const root = statusBar.shadowRoot;

    expect(root?.textContent).toContain("↑12k");
    expect(root?.textContent).toContain("↓3.4k");
    expect(root?.textContent).toContain("cache read 2.5k");
    expect(root?.textContent).toContain("cache write 750");
    expect(root?.textContent).toContain("context 0.6%/128k");
    expect(root?.textContent).toContain("session $0.12");
    expect(root?.textContent).toContain("2 queued");
    const cost = root?.querySelector("[title^='Session-reported cost']");
    expect(cost).not.toBeNull();
    expect(cost?.getAttribute("title")).toContain("may include reported tool/subagent usage");
    expect(cost?.getAttribute("title")).toContain("not a complete fleet total");
    expect(cost?.getAttribute("aria-description")).toContain("may include reported tool/subagent usage");
    expect(cost?.getAttribute("aria-description")).toContain("not a complete fleet total");
    expect(root?.querySelector("[title^='Provider-reported cumulative cache-write']")?.getAttribute("aria-description"))
      .toContain("separate from input/output totals");
  });

  it("keeps current context unknown when no context usage is available", async () => {
    const statusBar = await mountStatusBar(makeStatus({
      tokens: { input: 9_000, output: 2_000, cacheRead: 1_000, cacheWrite: 500, total: 12_500 },
    }));

    expect(statusBar.shadowRoot?.textContent).toContain("context unknown");
    expect(statusBar.shadowRoot?.textContent).toContain("cache read 1.0k");
  });

  it("marks non-finite cache counts and context percentages unknown", async () => {
    const statusBar = await mountStatusBar(makeStatus({
      tokens: { input: 0, output: 0, cacheRead: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY, total: 0 },
      contextUsage: { tokens: null, contextWindow: 128_000, percent: Number.NaN },
    }));
    const rendered = statusBar.shadowRoot?.textContent ?? "";

    expect(rendered).toContain("cache read unknown");
    expect(rendered).toContain("cache write unknown");
    expect(rendered).toContain("context unknown");
    expect(rendered).not.toMatch(/NaN|Infinity/);
  });

  it("keeps context unknown when the context window is zero", async () => {
    const statusBar = await mountStatusBar(makeStatus({
      contextUsage: { tokens: 0, contextWindow: 0, percent: 25 },
    }));

    expect(statusBar.shadowRoot?.textContent).toContain("context unknown");
    expect(statusBar.shadowRoot?.textContent).not.toContain("25.0%/0");
  });

  it("formats large provider cache counts compactly", async () => {
    const statusBar = await mountStatusBar(makeStatus({
      tokens: { input: 0, output: 0, cacheRead: 123_456_789, cacheWrite: 987_654_321, total: 0 },
    }));

    expect(statusBar.shadowRoot?.textContent).toContain("cache read 123M");
    expect(statusBar.shadowRoot?.textContent).toContain("cache write 988M");
  });
});

async function mountStatusBar(sessionStatus: SessionStatus): Promise<StatusBar> {
  const statusBar = new StatusBar();
  statusBar.status = sessionStatus;
  document.body.append(statusBar);
  await statusBar.updateComplete;
  return statusBar;
}

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...overrides,
  };
}
