import { describe, expect, it } from "vitest";
import type { Machine } from "../../api";
import { shouldShowMachineContext } from "./AppContextBar";

describe("shouldShowMachineContext", () => {
  it("hides the machine crumb when there is no machine choice", () => {
    expect(shouldShowMachineContext([])).toBe(false);
    expect(shouldShowMachineContext([machine("local")])).toBe(false);
  });

  it("shows the machine crumb when multiple machines exist", () => {
    expect(shouldShowMachineContext([machine("local"), machine("remote-a")])).toBe(true);
  });
});

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}
