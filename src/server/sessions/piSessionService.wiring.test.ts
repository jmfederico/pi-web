import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionServices, CreateAgentSessionServicesOptions, InlineExtension } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime } from "./piSessionService.testSupport.js";

const { captureServices, builtinFactories } = vi.hoisted(() => ({
  captureServices: vi.fn<(options: CreateAgentSessionServicesOptions) => Promise<AgentSessionServices>>(),
  builtinFactories: [
    { name: "__wiring-test-mcp__", factory: () => undefined, builtin: true, replaceable: true },
    { name: "__wiring-test-codemode__", factory: () => undefined, builtin: true, replaceable: true },
    { name: "__wiring-test-tool-search__", factory: () => undefined, builtin: true, replaceable: true },
  ] satisfies InlineExtension[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSessionServices: captureServices,
}));

vi.mock("./builtinExtensionFactories.js", () => ({
  getBuiltinExtensionFactories: () => Promise.resolve(builtinFactories),
}));

beforeEach(() => {
  // Stop at the SDK boundary after recording the options, without starting
  // an agent or any MCP connections.
  captureServices.mockReset().mockRejectedValue(new Error("capture-only session services"));
});

describe("PiSessionService builtin extension factory wiring", () => {
  it.each([
    { label: "without prompt additions", sections: [] },
    { label: "with prompt additions", sections: ["PI WEB deployment facts"] },
  ])("preserves factories, event bus, and prompt options $label", async ({ sections }) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-wiring-"));
    const modelRuntime = await createTestModelRuntime();
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: directory,
      modelRuntime,
      sessionManager: createPiSessionManagerGateway({ agentDir: directory, env: {} }),
      heartbeatIntervalMs: 60_000,
      appendSystemPromptSections: sections,
    });

    try {
      await expect(service.start(directory)).rejects.toThrow("capture-only session services");
      expect(captureServices).toHaveBeenCalledTimes(1);
      const options = captureServices.mock.calls[0]?.[0].resourceLoaderOptions;
      expect(options?.extensionFactories).toEqual(expect.arrayContaining(builtinFactories));
      expect(options?.eventBus).toBeDefined();
      if (sections.length === 0) {
        expect(options?.appendSystemPromptOverride).toBeUndefined();
      } else {
        expect(options?.appendSystemPromptOverride?.(["Existing prompt section"])).toEqual([
          "Existing prompt section",
          ...sections,
        ]);
      }
    } finally {
      try {
        await service.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
