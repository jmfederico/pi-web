import { afterEach, describe, expect, it, vi } from "vitest";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(inset: number, innerHeight: number): { applied: Record<string, string>; app: PiWebApp } {
  const probe = { style: {}, offsetHeight: inset, remove: () => undefined };
  vi.stubGlobal("document", { createElement: () => probe, body: { appendChild: () => undefined } });
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    innerHeight,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const app = new PiWebApp();
  const applied: Record<string, string> = {};
  Object.defineProperty(app, "style", {
    configurable: true,
    value: { setProperty: (name: string, value: string) => { applied[name] = value; }, getPropertyValue: () => "" },
  });
  return { applied, app };
}

describe("PiWebApp viewport metrics", () => {
  it("drives the root height from the live viewport and applies the measured safe-area inset", () => {
    const { applied, app } = setup(56, 800);
    // @ts-expect-error - exercise the private updater in isolation
    app.updateViewportMetrics();
    expect(applied["--pi-app-height"]).toBe("800px");
    expect(applied["--pi-app-safe-area-bottom"]).toBe("56px");
  });

  it("does not reserve an inset when env() reports 0 (e.g. desktop, or before the browser measures it)", () => {
    const { applied, app } = setup(0, 900);
    // @ts-expect-error - exercise the private updater in isolation
    app.updateViewportMetrics();
    expect(applied["--pi-app-height"]).toBe("900px");
    expect(applied["--pi-app-safe-area-bottom"]).toBe("0px");
  });
});
