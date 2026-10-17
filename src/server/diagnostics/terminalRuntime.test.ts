import { afterEach, describe, expect, it } from "vitest";
import { checkTerminalRuntime, formatTerminalRuntimeCheck } from "./terminalRuntime.js";

// piWebRuntimeKind() reads PI_WEB_RUNTIME, so tests that need a "bun" runtime must set it.
// bunTerminalCapability() still checks globalThis.Bun.Terminal for the native capability.
const savedEnv = process.env["PI_WEB_RUNTIME"];

afterEach(() => {
  if (savedEnv === undefined) delete process.env["PI_WEB_RUNTIME"];
  else process.env["PI_WEB_RUNTIME"] = savedEnv;
});

function asBun(terminals: boolean): void {
  process.env["PI_WEB_RUNTIME"] = "bun";
  // Also stub the Bun global so bunTerminalCapability() can see it.
  const bunStub: Record<string, unknown> = { spawn: () => undefined };
  if (terminals) bunStub["Terminal"] = () => undefined;
  Reflect.set(globalThis, "Bun", bunStub);
}

function asNode(): void {
  delete process.env["PI_WEB_RUNTIME"];
  Reflect.deleteProperty(globalThis, "Bun");
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

  // The factory falls back to node-pty on a bun without Bun.Terminal (SPEC §4.4), but under bun
  // the missing binding is non-blocking: Bun.Terminal handles terminals natively and node-pty
  // becomes available when the user adds it. The report names the situation without failing.
  it("names the node-pty fallback when Bun.Terminal is missing", () => {
    asBun(false);

    const inspection = checkTerminalRuntime({ loadNodePty: nodePtyFails });
    const report = formatTerminalRuntimeCheck(inspection);

    expect(inspection.runtime).toBe("bun");
    expect(inspection.backend).toBe("node-pty");
    expect(report.ok).toBe(true);
    expect(report.lines[0]).toBe("runtime: bun");
    expect(report.lines.join("\n")).toContain("Bun.Terminal unavailable");
    expect(report.lines.join("\n")).toContain("node-pty will be used when installed");
  });

  it("passes an old bun that still has a working node-pty", () => {
    asBun(false);

    const report = formatTerminalRuntimeCheck(checkTerminalRuntime({ loadNodePty: nodePtyLoads }));

    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("Bun.Terminal unavailable");
    expect(report.lines.join("\n")).toContain("✓ terminals: node-pty");
  });
});

describe("terminal runtime diagnostics under node", () => {
  it("keeps failing the section with npm advice when node-pty cannot load", () => {
    asNode();

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
    asNode();

    const report = formatTerminalRuntimeCheck(checkTerminalRuntime({ loadNodePty: nodePtyLoads }));

    expect(report).toEqual({
      ok: true,
      lines: ["runtime: node", "✓ node-pty native module loadable"],
    });
  });
});
