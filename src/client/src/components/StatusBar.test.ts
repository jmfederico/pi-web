import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { templateEventHandlerAfterMarker } from "../templateInspection.testSupport";
import { StatusBar, statusBarWarningControlContent } from "./StatusBar";

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
  // Escape hatch: this specifically verifies the compact status-bar button's
  // Lit callback wiring in the node environment, anchored to its semantic class.
  it("invokes onToggleWarnings when the warning-count control is activated", () => {
    const statusBar = new StatusBar();
    const onToggleWarnings = vi.fn();
    statusBar.status = status();
    statusBar.warningCount = 2;
    statusBar.warningsExpanded = true;
    statusBar.onToggleWarnings = onToggleWarnings;

    templateEventHandlerAfterMarker(renderStatusBar(statusBar), "warning-toggle")(new Event("click"));

    expect(onToggleWarnings).toHaveBeenCalledOnce();
  });
});

type RenderStatusBar = (this: StatusBar) => TemplateResult;

function renderStatusBar(statusBar: StatusBar): TemplateResult {
  const method: unknown = Reflect.get(statusBar, "render");
  if (!isRenderStatusBar(method)) throw new Error("StatusBar.render is not callable");
  return method.call(statusBar);
}

function isRenderStatusBar(value: unknown): value is RenderStatusBar {
  return typeof value === "function";
}

function status(): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}
