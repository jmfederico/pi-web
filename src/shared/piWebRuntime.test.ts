import { afterEach, describe, expect, it } from "vitest";
import { bunTerminalCapability, piWebRuntimeKind } from "./piWebRuntime.js";

// The runtime detector reads the `Bun` global, so the tests have to move it. Reflect keeps that
// legal without type assertions: globalThis has no index signature on purpose.
const originalBun: unknown = Reflect.get(globalThis, "Bun");

afterEach(() => {
  if (originalBun === undefined) Reflect.deleteProperty(globalThis, "Bun");
  else Reflect.set(globalThis, "Bun", originalBun);
});

function setBun(value: unknown): void {
  Reflect.set(globalThis, "Bun", value);
}

describe("PI WEB runtime detection", () => {
  it("reports node when the Bun global is absent", () => {
    setBun(undefined);

    expect(piWebRuntimeKind()).toBe("node");
    expect(bunTerminalCapability()).toBe(false);
  });

  it("reports bun when the Bun global exposes spawn", () => {
    setBun({ spawn: () => undefined, Terminal: () => undefined });

    expect(piWebRuntimeKind()).toBe("bun");
    expect(bunTerminalCapability()).toBe(true);
  });

  // The launcher gates bun selection on the same capability, and the terminal factory falls back
  // on it; a runtime that has Bun.spawn but no Bun.Terminal cannot drive a PTY natively.
  it("separates the runtime from the Bun.Terminal capability", () => {
    setBun({ spawn: () => undefined });

    expect(piWebRuntimeKind()).toBe("bun");
    expect(bunTerminalCapability()).toBe(false);
  });

  it("does not treat a non-function Bun global as the bun runtime", () => {
    setBun("Bun");

    expect(piWebRuntimeKind()).toBe("node");
  });
});
