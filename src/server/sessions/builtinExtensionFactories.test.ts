import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@earendil-works/pi-coding-agent");
  vi.resetModules();
});

async function loadFactories(sdkExports: Record<string, unknown>) {
  vi.doMock("@earendil-works/pi-coding-agent", () => sdkExports);
  return (await import("./builtinExtensionFactories.js")).getBuiltinExtensionFactories;
}

function builtinCreators() {
  const mcp: ExtensionFactory = () => undefined;
  const codemode: ExtensionFactory = () => undefined;
  const toolSearch: ExtensionFactory = () => undefined;
  return {
    factories: { mcp, codemode, toolSearch },
    exports: {
      createMcpExtension: vi.fn(() => mcp),
      createCodemodeExtension: vi.fn(() => codemode),
      createToolSearchExtension: vi.fn(() => toolSearch),
    },
  };
}

describe("getBuiltinExtensionFactories", () => {
  it("registers all Pi 1.x builtins as named, replaceable extensions", async () => {
    const { factories, exports } = builtinCreators();
    const getFactories = await loadFactories(exports);

    const result = await getFactories();
    expect(result[0]).toMatchObject({ name: "mcp", builtin: true, replaceable: true });
    const mcp = result[0];
    if (typeof mcp !== "object") throw new Error("Expected a named MCP extension");
    expect(typeof mcp.factory).toBe("function");
    expect(result.slice(1)).toEqual([
      { name: "codemode", factory: factories.codemode, builtin: true, replaceable: true },
      { name: "tool-search", factory: factories.toolSearch, builtin: true, replaceable: true },
    ]);
  });

  it("creates factories once for concurrent and subsequent callers", async () => {
    const { exports } = builtinCreators();
    const getFactories = await loadFactories(exports);

    const [first, concurrent] = await Promise.all([getFactories(), getFactories()]);
    expect(concurrent).toBe(first);
    expect(await getFactories()).toBe(first);
    for (const create of Object.values(exports)) {
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("propagates factory initialization errors instead of silently disabling builtins", async () => {
    const error = new Error("MCP factory initialization failed");
    const { exports } = builtinCreators();
    const getFactories = await loadFactories({
      ...exports,
      createMcpExtension: () => { throw error; },
    });
    await expect(getFactories()).rejects.toBe(error);
  });
});
