import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

export function createTestModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
}
const catalog = await createTestModelRuntime();
export function testModel() {
  const model = catalog.getModel("anthropic", "claude-sonnet-4-5-20250929");
  if (model === undefined) throw new Error("Test model unavailable");
  return model;
}

export const stdioServer = String.raw`
const readline = require("node:readline").createInterface({ input: process.stdin });
readline.on("close", () => process.exit(0));
readline.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lifecycle", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }] }
      : { content: [{ type: "text", text: "echo" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`;
