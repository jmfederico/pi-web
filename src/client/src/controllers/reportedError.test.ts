import { describe, expect, it } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { ReportedError } from "./reportedError";

function harness() {
  let state: AppState = initialAppState();
  return {
    reported: new ReportedError(() => state, (patch) => { state = { ...state, ...patch }; }),
    get error(): string { return state.error; },
    set error(value: string) { state = { ...state, error: value }; },
  };
}

describe("ReportedError", () => {
  it("clears only the message it reported itself", () => {
    const app = harness();

    app.reported.report("Files could not be listed");
    expect(app.error).toBe("Files could not be listed");

    app.reported.clear();
    expect(app.error).toBe("");
  });

  it("leaves another action's message in place on success", () => {
    const app = harness();

    app.reported.report("Files could not be listed");
    app.error = "Failed to start workspace removal: HTTP request cancelled";
    app.reported.clear();

    expect(app.error).toBe("Failed to start workspace removal: HTTP request cancelled");
  });

  it("does not clear a banner it never reported", () => {
    const app = harness();
    app.error = "Delete failed: workspace is busy";

    app.reported.clear();

    expect(app.error).toBe("Delete failed: workspace is busy");
  });

  it("stops owning the banner after a clear, so a later unrelated message survives", () => {
    const app = harness();

    app.reported.report("Files could not be listed");
    app.reported.clear();
    app.error = "Files could not be listed";
    app.reported.clear();

    expect(app.error).toBe("Files could not be listed");
  });
});
