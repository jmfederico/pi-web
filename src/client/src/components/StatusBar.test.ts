import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { templateEventHandlerAfterMarker } from "../templateInspection.testSupport";
import { StatusBar, statusBarWarningControlContent } from "./StatusBar";

describe("statusBarWarningControlContent", () => {
  it("provides only the visible numeric count while keeping a descriptive accessible label", () => {
    expect(statusBarWarningControlContent(1)).toEqual({
      countText: "1",
      accessibleLabel: "Show 1 warning in the warning area",
    });
    expect(statusBarWarningControlContent(3)).toEqual({
      countText: "3",
      accessibleLabel: "Show 3 warnings in the warning area",
    });
  });

  it("omits the control content when there are no collapsed warnings", () => {
    expect(statusBarWarningControlContent(0)).toBeUndefined();
  });
});

describe("StatusBar warning restore wiring", () => {
  // Escape hatch: this specifically verifies the compact status-bar button's
  // Lit callback wiring in the node environment, anchored to its semantic class.
  it("invokes onRestoreWarnings when the warning-count control is activated", () => {
    const statusBar = new StatusBar();
    const onRestoreWarnings = vi.fn();
    statusBar.status = status();
    statusBar.collapsedWarningCount = 2;
    statusBar.onRestoreWarnings = onRestoreWarnings;

    templateEventHandlerAfterMarker(renderStatusBar(statusBar), "warning-restore")(new Event("click"));

    expect(onRestoreWarnings).toHaveBeenCalledOnce();
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
