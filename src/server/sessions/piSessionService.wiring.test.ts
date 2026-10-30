import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionServices, CreateAgentSessionServicesOptions, InlineExtension } from "../../piSdk.js";
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

vi.mock("../../piSdk.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../piSdk.js")>(),
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
    { label: "without prompt additions", sections: [], parentId: undefined },
    { label: "with prompt additions", sections: ["PI WEB deployment facts"], parentId: undefined },
    { label: "with parent context", sections: [], parentId: "parent-session" },
    { label: "with parent context and prompt additions", sections: ["PI WEB deployment facts"], parentId: "parent-session" },
  ])("preserves factories, event bus, and prompt options $label", async ({ sections, parentId }) => {
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
      const parentSession = parentId === undefined ? undefined : join(directory, "parent.jsonl");
      if (parentSession !== undefined) {
        await writeFile(parentSession, `${JSON.stringify({ type: "session", version: 3, id: parentId, cwd: directory, timestamp: new Date().toISOString() })}\n`);
      }
      await expect(service.start(directory, parentSession === undefined ? {} : { parentSession })).rejects.toThrow("capture-only session services");
      expect(captureServices).toHaveBeenCalledTimes(1);
      const options = captureServices.mock.calls[0]?.[0].resourceLoaderOptions;
      expect(options?.extensionFactories).toEqual(expect.arrayContaining(builtinFactories));
      expect(options?.eventBus).toBeDefined();
      if (sections.length === 0 && parentId === undefined) {
        expect(options?.appendSystemPromptOverride).toBeUndefined();
      } else {
        const appended = options?.appendSystemPromptOverride?.(["Existing prompt section"]);
        expect(appended?.slice(0, 1 + sections.length)).toEqual(["Existing prompt section", ...sections]);
        expect(appended).toHaveLength(1 + sections.length + (parentId === undefined ? 0 : 1));
        if (parentId !== undefined) expect(appended?.at(-1)).toContain(`Parent session ID: ${parentId}`);
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
