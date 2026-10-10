import { afterEach, describe, expect, it } from "vitest";
import { bunTerminalCapability, piWebRuntimeKind } from "./piWebRuntime.js";

// The runtime detector reads the `Bun` global and `PI_WEB_RUNTIME`, so the tests have to move
// them. Reflect keeps that legal without type assertions: globalThis has no index signature on
// purpose.
const originalBun: unknown = Reflect.get(globalThis, "Bun");
const originalEnv = process.env["PI_WEB_RUNTIME"];

afterEach(() => {
  if (originalBun === undefined) Reflect.deleteProperty(globalThis, "Bun");
  else Reflect.set(globalThis, "Bun", originalBun);
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "PI_WEB_RUNTIME");
  else process.env["PI_WEB_RUNTIME"] = originalEnv;
});

function setBun(value: unknown): void {
  Reflect.set(globalThis, "Bun", value);
}

function setEnv(value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, "PI_WEB_RUNTIME");
  else process.env["PI_WEB_RUNTIME"] = value;
}

describe("PI WEB runtime detection", () => {
  it("reports node when the Bun global is absent", () => {
    setBun(undefined);
    setEnv(undefined);

    expect(piWebRuntimeKind()).toBe("node");
    expect(bunTerminalCapability()).toBe(false);
  });

  it("reports node by default even when Bun is present", () => {
    setBun({ spawn: () => undefined, Terminal: () => undefined });
    setEnv(undefined);

    expect(piWebRuntimeKind()).toBe("node");
    expect(bunTerminalCapability()).toBe(true);
  });

  it("reports bun when PI_WEB_RUNTIME=bun and the Bun global exposes spawn", () => {
    setBun({ spawn: () => undefined, Terminal: () => undefined });
    setEnv("bun");

    expect(piWebRuntimeKind()).toBe("bun");
    expect(bunTerminalCapability()).toBe(true);
  });

  it("reports node when PI_WEB_RUNTIME=node", () => {
    setBun({ spawn: () => undefined, Terminal: () => undefined });
    setEnv("node");

    expect(piWebRuntimeKind()).toBe("node");
  });

  // PI_WEB_RUNTIME=node overrides the Bun global; the user explicitly asked for Node.
  it("honours PI_WEB_RUNTIME=node over a present Bun global", () => {
    setBun({ spawn: () => undefined, Terminal: () => undefined });
    setEnv("node");

    expect(piWebRuntimeKind()).toBe("node");
  });

  // The launcher gates bun selection on the same capability, and the terminal factory falls back
  // on it; a runtime that has Bun.spawn but no Bun.Terminal cannot drive a PTY natively.
  it("separates the runtime from the Bun.Terminal capability", () => {
    setBun({ spawn: () => undefined });
    setEnv(undefined);

    expect(piWebRuntimeKind()).toBe("node");
    expect(bunTerminalCapability()).toBe(false);
  });

  it("does not treat a non-function Bun global as the bun runtime", () => {
    setBun("Bun");
    setEnv(undefined);

    expect(piWebRuntimeKind()).toBe("node");
  });
});
