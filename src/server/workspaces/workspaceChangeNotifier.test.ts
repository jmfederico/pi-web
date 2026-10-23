import { expect, it, vi } from "vitest";
import { WorkspaceChangeNotifier } from "./workspaceChangeNotifier.js";

it("invalidates status attribution and notifies the browser with the same project scope", () => {
  const invalidate = vi.fn();
  const notifyChanged = vi.fn();
  const publish = vi.fn();
  new WorkspaceChangeNotifier({ attribution: { invalidate }, status: { notifyChanged }, publish }).notify("project-1");
  expect(invalidate).toHaveBeenCalledOnce();
  expect(notifyChanged).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledExactlyOnceWith({ type: "workspaces.changed", projectId: "project-1" });
});
