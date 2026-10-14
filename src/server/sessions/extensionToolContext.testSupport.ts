import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

type TestSessionManager = {
  getSessionId(): string;
  getSessionFile(): string | undefined;
};

type TestExtensionToolContextOptions = {
  model?: unknown;
  thinkingLevel?: unknown;
};

export function fakeExtensionToolContext(
  sessionManager: TestSessionManager,
  options: TestExtensionToolContextOptions = {},
): ExtensionToolContext {
  // These tools only need the session identity; unexpected nested tool calls fail clearly.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal tool context for focused unit tests.
  return {
    sessionManager,
    tools: [],
    executeTool: async () => {
      throw new Error("Nested tools are not configured in this test");
    },
    ...options,
  } as unknown as ExtensionToolContext;
}
