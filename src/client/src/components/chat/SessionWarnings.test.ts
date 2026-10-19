// @vitest-environment happy-dom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus, SessionWarning } from "../../api";
import { chatSessionWarningRows, renderSessionWarnings } from "./SessionWarnings";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function warningStatus(warnings: SessionWarning[]): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

function mountWarnings(status: SessionStatus, onToggle?: () => void, onDismiss?: (dismissId: string) => void): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderSessionWarnings(chatSessionWarningRows(status), onToggle, onDismiss), container);
  return container;
}

describe("chatSessionWarningRows", () => {
  // Warning-row content (severity class, message, path, source, dismiss
  // capability, ordering) is derived by this pure seam rather than scraped from
  // rendered markup.
  it("derives one severity-tagged row per warning with optional path and source", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "subscription auth is active" },
      { severity: "info", message: "heads up", source: "runtime" },
    ]));

    expect(rows).toEqual([
      { severity: "error", severityClass: "session-warning error", message: "skill failed to load", source: "skill", path: "/skills/a.md", dismissId: undefined },
      { severity: "warning", severityClass: "session-warning warning", message: "subscription auth is active", source: undefined, path: undefined, dismissId: undefined },
      { severity: "info", severityClass: "session-warning info", message: "heads up", source: "runtime", path: undefined, dismissId: undefined },
    ]);
  });

  it("exposes a dismiss id only for warnings carrying a dismiss capability", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill" },
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]));

    expect(rows.map((row) => row.dismissId)).toEqual([undefined, "anthropicExtraUsage"]);
  });

  it("derives no rows when there are no warnings or status is unset", () => {
    expect(chatSessionWarningRows(warningStatus([]))).toEqual([]);
    expect(chatSessionWarningRows(undefined)).toEqual([]);
  });
});

describe("session warning controls", () => {
  const dismissable = warningStatus([
    { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
  ]);

  it("invokes the dismiss callback with the warning's dismiss id", () => {
    const onDismiss = vi.fn();
    const container = mountWarnings(dismissable, undefined, onDismiss);

    container.querySelector<HTMLButtonElement>(".session-warning-dismiss")?.click();

    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("anthropicExtraUsage");
  });

  it("omits the dismiss control for a warning without a dismiss capability", () => {
    const container = mountWarnings(warningStatus([{ severity: "warning", message: "subscription auth is active" }]), undefined, vi.fn());

    expect(container.querySelector(".session-warning-dismiss")).toBeNull();
  });

  it("invokes the toggle callback from the minimise control", () => {
    const onToggle = vi.fn();
    const container = mountWarnings(dismissable, onToggle);

    container.querySelector<HTMLButtonElement>(".session-warnings-collapse")?.click();

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders no toggle control when the owner supplies no visibility action", () => {
    const container = mountWarnings(dismissable);

    expect(container.querySelector(".session-warnings-collapse")).toBeNull();
  });

  it("renders one severity class per warning row", () => {
    const container = mountWarnings(warningStatus([
      { severity: "error", message: "skill failed to load" },
      { severity: "info", message: "heads up" },
    ]));

    expect(Array.from(container.querySelectorAll(".session-warning")).map((row) => row.className))
      .toEqual(["session-warning error", "session-warning info"]);
  });
});
