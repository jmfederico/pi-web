import type { ExtensionFactory } from "../../piSdk.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../../piSdk.js");
  vi.resetModules();
});

async function loadFactories(sdkExports: Record<string, unknown>) {
  vi.doMock("../../piSdk.js", () => sdkExports);
  return (await import("./builtinExtensionFactories.js")).getBuiltinExtensionFactories;
}

function builtinCreators() {
  const mcp: ExtensionFactory = () => undefined;
  const codemode: ExtensionFactory = () => undefined;
  const toolSearch: ExtensionFactory = () => undefined;
  return {
    factories: { mcp, codemode, toolSearch },
    exports: {
      createMcpExtension: vi.fn<(options?: { openUrl?: (url: string) => void }) => ExtensionFactory>(() => mcp),
      createCodemodeExtension: vi.fn(() => codemode),
      createToolSearchExtension: vi.fn(() => toolSearch),
    },
  };
}

describe("getBuiltinExtensionFactories", () => {
  it("registers all Pi 1.x builtins as named, replaceable extensions", async () => {
    const { factories, exports } = builtinCreators();
    const getFactories = await loadFactories(exports);

    expect(await getFactories()).toEqual([
      { name: "mcp", factory: factories.mcp, builtin: true, replaceable: true },
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

  it("captures structured MCP URLs through the public factory hook without launching a host browser", async () => {
    const { exports } = builtinCreators();
    const getFactories = await loadFactories(exports);
    await getFactories();
    const openUrl = exports.createMcpExtension.mock.calls[0]?.[0]?.openUrl;
    if (!openUrl) throw new Error("Missing public openUrl hook");
    const { McpAuthFlowService } = await import("./mcpAuthFlowService.js");
    const flows = new McpAuthFlowService();
    try {
      const flow = flows.start({ sessionId: "session", identity: {}, isCurrent: () => true, run: () => {
        openUrl("https://example.test/authorize");
        return Promise.resolve();
      } });
      expect(flow.auth).toEqual({ url: "https://example.test/authorize" });
    } finally {
      flows.dispose();
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
