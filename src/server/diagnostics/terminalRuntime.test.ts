import { afterEach, describe, expect, it } from "vitest";
import { checkTerminalRuntime, formatTerminalRuntimeCheck } from "./terminalRuntime.js";

// The detector reads the `Bun` global, so these tests move it with Reflect instead of asserting
// an index signature onto globalThis.
const originalBun: unknown = Reflect.get(globalThis, "Bun");

afterEach(() => {
  if (originalBun === undefined) Reflect.deleteProperty(globalThis, "Bun");
  else Reflect.set(globalThis, "Bun", originalBun);
});

function asBun(terminals: boolean): void {
  Reflect.set(globalThis, "Bun", {
    spawn: () => undefined,
    ...(terminals ? { Terminal: () => undefined } : {}),
  });
}

const nodePtyLoads = (): unknown => ({ spawn: () => undefined });
const nodePtyFails = (): never => {
  throw new Error("Could not locate the bindings file");
};

/**
 * ACCEPTANCE A6: the terminal section states the runtime it is talking about and only judges
 * node-pty when node-pty is what the backend factory would actually pick. Under bun the node-pty
 * check must not run at all: a bun install usually has no built native binding (bun runs a
 * dependency's install script only under its trust policy), and the old behaviour was a red
 * section recommending an npm reinstall for a package the user installed with bun.
 */
describe("terminal runtime diagnostics under bun", () => {
  it("passes on the native Bun backend without any node-pty or npm advice", () => {
    asBun(true);

    const inspection = checkTerminalRuntime({ loadNodePty: nodePtyFails });

    expect(inspection).toEqual({ runtime: "bun", backend: "bun", bunTerminal: true, nodePty: null });
    expect(formatTerminalRuntimeCheck(inspection)).toEqual({
      ok: true,
      lines: ["runtime: bun", "✓ terminals: Bun native PTY (Bun.Terminal)"],
    });
  });

  // The factory falls back to node-pty on a bun without Bun.Terminal (SPEC §4.4), so doctor names
  // the effective backend and shows what it needs instead of reporting a healthy terminal stack.
  it("names the node-pty fallback when Bun.Terminal is missing", () => {
    asBun(false);

    const inspection = checkTerminalRuntime({ loadNodePty: nodePtyFails });
    const report = formatTerminalRuntimeCheck(inspection);

    expect(inspection.runtime).toBe("bun");
    expect(inspection.backend).toBe("node-pty");
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toBe("runtime: bun");
    expect(report.lines[1]).toBe("! terminals: Bun.Terminal unavailable — falling back to node-pty");
    expect(report.lines.join("\n")).toContain("✗ node-pty native module loadable");
    expect(report.lines.join("\n")).toContain("npm install -g @jmfederico/pi-web --allow-scripts=node-pty");
  });

  it("passes an old bun that still has a working node-pty", () => {
    asBun(false);

    const report = formatTerminalRuntimeCheck(checkTerminalRuntime({ loadNodePty: nodePtyLoads }));

    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("Bun.Terminal unavailable");
    expect(report.lines.join("\n")).toContain("✓ node-pty native module loadable");
  });
});

describe("terminal runtime diagnostics under node", () => {
  it("keeps failing the section with npm advice when node-pty cannot load", () => {
    Reflect.deleteProperty(globalThis, "Bun");

    const inspection = checkTerminalRuntime({ loadNodePty: nodePtyFails });
    const report = formatTerminalRuntimeCheck(inspection);

    expect(inspection.runtime).toBe("node");
    expect(inspection.backend).toBe("node-pty");
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toBe("runtime: node");
    expect(report.lines.join("\n")).toContain("✗ node-pty native module loadable");
    expect(report.lines.join("\n")).toContain("npm install -g @jmfederico/pi-web --allow-scripts=node-pty");
  });

  it("reports the node runtime and the node-pty verdict when it loads", () => {
    Reflect.deleteProperty(globalThis, "Bun");

    const report = formatTerminalRuntimeCheck(checkTerminalRuntime({ loadNodePty: nodePtyLoads }));

    expect(report).toEqual({
      ok: true,
      lines: ["runtime: node", "✓ node-pty native module loadable"],
    });
  });
});
