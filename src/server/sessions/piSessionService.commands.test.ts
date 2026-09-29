import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

beforeEach(() => {
  // These tests exercise the fake runtime and must never fetch provider catalogs.
  vi.stubEnv("PI_OFFLINE", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PiSessionService commands", () => {
  it("forwards prompt template argument hints and declares builtin argument hints", async () => {
    const fake = fakeRuntime("commands-session", {
      promptTemplates: [
        { name: "pr", description: "Review PRs from URLs", argumentHint: "<PR-URL>" },
        { name: "cl", description: "Audit changelog entries" },
      ],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("commands-session")]),
      heartbeatIntervalMs: 60_000,
    });

    const commands = await service.commands(sessionRef("commands-session"));

    expect(commands.find((command) => command.name === "pr")).toEqual({
      name: "pr",
      description: "Review PRs from URLs",
      argumentHint: "<PR-URL>",
      source: "prompt",
    });
    // Templates without an argument-hint frontmatter stay hintless.
    expect(commands.find((command) => command.name === "cl")).toEqual({
      name: "cl",
      description: "Audit changelog entries",
      source: "prompt",
    });
    expect(commands.find((command) => command.name === "name")).toMatchObject({ argumentHint: "<session name>", source: "builtin" });
    expect(commands.find((command) => command.name === "compact")).toMatchObject({ argumentHint: "[instructions]", source: "builtin" });
    // Argument-less builtins must not claim one.
    expect(commands.find((command) => command.name === "tree")).not.toHaveProperty("argumentHint");
    await service.dispose();
  });
});
