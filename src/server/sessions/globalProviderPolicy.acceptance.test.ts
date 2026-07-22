import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { installGlobalProviderPolicy, providerRejectionMessage } from "./globalProviderPolicy.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, TEST_MODEL_ID, TEST_MODEL_PROVIDER } from "./piSessionService.testSupport.js";

/**
 * Acceptance tests for the global provider policy, wired exactly as sessiond
 * wires it in production: one shared ModelRuntime per daemon, the policy shim
 * installed on it, and rejections fed into the session service. Sessions are
 * created through the real default runtime factory, so project extensions in a
 * temp cwd are genuinely loaded by Pi's `createAgentSessionServices`.
 *
 * These tests are also the tripwire for the shim's one piece of machinery
 * (instance-method shadowing of `registerProvider`): if a Pi upgrade changes
 * how registrations reach the runtime, the load-time and late-registration
 * tests here fail loudly.
 */

const tempDirs: string[] = [];
const services: PiSessionService[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map(async (service) => service.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface PolicyHarness {
  service: PiSessionService;
  runtime: ModelRuntime;
  agentDir: string;
}

async function policyHarness(options: { runtime?: ModelRuntime; agentDir?: string } = {}): Promise<PolicyHarness> {
  const agentDir = options.agentDir ?? await tempDir("pi-web-policy-agent-");
  // Isolate Pi's per-user resource discovery (~/.agents/skills et al.) so the
  // only extensions loaded are the ones a test writes into its temp cwd.
  vi.stubEnv("HOME", await tempDir("pi-web-policy-home-"));
  const runtime = options.runtime ?? await createTestModelRuntime();
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir,
    modelRuntime: runtime,
    sessionManager: createPiSessionManagerGateway({ agentDir, env: {}, sessionDirEnvKeys: [] }),
    heartbeatIntervalMs: 60_000,
  });
  services.push(service);
  // The exact sessiond wiring: policy on the shared runtime, rejections to the service.
  installGlobalProviderPolicy(runtime, (providerId) => { service.noteRejectedProviderRegistration(providerId); });
  return { service, runtime, agentDir };
}

/** Write a project extension into `<cwd>/.pi/extensions/` and return the cwd. */
async function projectWithExtension(source: string): Promise<string> {
  const cwd = await tempDir("pi-web-policy-project-");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(cwd, ".pi", "extensions", "probe.js"), source);
  return cwd;
}

function providerConfig(providerId: string): Record<string, unknown> {
  return {
    baseUrl: `https://${providerId}.example.com`,
    apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "model-1", name: "Model One", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  };
}

function providerConfigJson(providerId: string): string {
  return JSON.stringify(providerConfig(providerId));
}

/** Parse the session-start marker file without type assertions. */
function parseToolMarker(raw: string): { activeTools: string[]; allTools: string[] } {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("activeTools" in value) || !("allTools" in value)) {
    throw new Error(`Unexpected marker content: ${raw}`);
  }
  const { activeTools, allTools } = value;
  if (!Array.isArray(activeTools) || !Array.isArray(allTools)) throw new Error(`Unexpected marker content: ${raw}`);
  return { activeTools: activeTools.map(String), allTools: allTools.map(String) };
}

function providerRegistrationSource(providerId: string): string {
  return `pi.registerProvider(${JSON.stringify(providerId)}, ${providerConfigJson(providerId)});`;
}

const POLICY_WORDING = "PI WEB only supports globally configured providers";

describe("global provider policy acceptance", () => {
  it("rejects a load-time provider registration while the extension's tool and command keep working", async () => {
    const { service, runtime } = await policyHarness();
    const markerPath = join(await tempDir("pi-web-policy-marker-"), "session-start.json");
    const cwd = await projectWithExtension(`
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        ${providerRegistrationSource("acme-ext")}
        pi.registerTool({
          name: "acme_tool",
          label: "Acme Tool",
          description: "acceptance probe tool",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "acme ok" }] }; },
        });
        pi.registerCommand("acme-cmd", { description: "acceptance probe command", async handler() {} });
        pi.on("session_start", async () => {
          writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
            activeTools: pi.getActiveTools(),
            allTools: pi.getAllTools().map((tool) => tool.name),
          }));
        });
      }
    `);

    const session = await service.start(cwd);
    const ref = { id: session.id, cwd };

    // The session opens and the rejection is surfaced as the session's one warning.
    const status = await service.status(ref);
    expect(status.warnings).toEqual([
      { severity: "warning", message: providerRejectionMessage("acme-ext", cwd), source: "runtime" },
    ]);

    // The provider never reached the shared runtime or the model listings.
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(runtime.getModel("acme-ext", "model-1")).toBeUndefined();
    const models = await service.availableModels(ref);
    expect(models.some((model) => model.provider === "acme-ext")).toBe(false);

    // Global (built-in) providers are untouched.
    expect(runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBeDefined();

    // Everything else the extension registered still works.
    const commands = await service.commands(ref);
    expect(commands).toContainEqual({ name: "acme-cmd", description: "acceptance probe command", source: "extension" });
    const marker = parseToolMarker(await readFile(markerPath, "utf-8"));
    expect(marker.activeTools).toContain("acme_tool");
  });

  it("appends exactly one warning diagnostic per rejected provider", async () => {
    const { service } = await policyHarness();
    const cwd = await projectWithExtension(`
      export default function (pi) {
        ${providerRegistrationSource("multi-a")}
        ${providerRegistrationSource("multi-b")}
        ${providerRegistrationSource("multi-a")}
      }
    `);

    const session = await service.start(cwd);
    const status = await service.status({ id: session.id, cwd });

    expect(status.warnings).toEqual([
      { severity: "warning", message: providerRejectionMessage("multi-a", cwd), source: "runtime" },
      { severity: "warning", message: providerRejectionMessage("multi-b", cwd), source: "runtime" },
    ]);
  });

  it("adds no policy warning when a load registers no providers", async () => {
    const { service } = await policyHarness();
    const cwd = await tempDir("pi-web-policy-project-");

    const session = await service.start(cwd);
    const status = await service.status({ id: session.id, cwd });

    expect((status.warnings ?? []).filter((warning) => warning.message.includes(POLICY_WORDING))).toEqual([]);
  });

  it("rejects a late registration from a session event handler and notifies active sessions", async () => {
    const { service, runtime } = await policyHarness();
    const plainCwd = await tempDir("pi-web-policy-project-");
    const listenerCwd = await projectWithExtension(`
      export default function (pi) {
        pi.on("session_start", () => {
          ${providerRegistrationSource("late-acme")}
        });
      }
    `);

    // The listener session's `session_start` fires while it is being bound,
    // after the load-time rejection window has closed: a late registration.
    const bystander = await service.start(plainCwd);
    await service.start(listenerCwd);

    // The rejection is broadcast to the sessions active at the time.
    const inbox = service.notificationInbox({ id: bystander.id, cwd: plainCwd });
    const notices = inbox.notifications.filter((notification) => notification.message.includes(POLICY_WORDING));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ severity: "warning", message: providerRejectionMessage("late-acme") });

    // The late registration never reached the shared runtime either.
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(runtime.getModel("late-acme", "model-1")).toBeUndefined();
  });

  it("keeps workspaces with colliding provider ids from affecting each other", async () => {
    const { service, runtime } = await policyHarness();
    const collisionSource = `
      export default function (pi) {
        ${providerRegistrationSource("collide-acme")}
      }
    `;
    const cwdA = await projectWithExtension(collisionSource);
    const cwdB = await projectWithExtension(collisionSource);

    // The pre-#76 scenario: two workspaces register the same provider id on the
    // shared runtime. With the policy, both sessions open and neither
    // registration exists, so there is nothing left to collide.
    const sessionA = await service.start(cwdA);
    const sessionB = await service.start(cwdB);

    expect((await service.status({ id: sessionA.id, cwd: cwdA })).warnings).toEqual([
      { severity: "warning", message: providerRejectionMessage("collide-acme", cwdA), source: "runtime" },
    ]);
    expect((await service.status({ id: sessionB.id, cwd: cwdB })).warnings).toEqual([
      { severity: "warning", message: providerRejectionMessage("collide-acme", cwdB), source: "runtime" },
    ]);
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(runtime.getModel("collide-acme", "model-1")).toBeUndefined();
  });

  it("does not let a project-level models.json alter the shared runtime's provider set", async () => {
    // Spike assertion for plan §2: the shared runtime reads providers from the
    // agent-dir models.json only. A project-level models.json is not a
    // scoped-provider vector.
    const agentDir = await tempDir("pi-web-policy-agent-");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { "global-acme": providerConfig("global-acme") },
    }));
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const { service } = await policyHarness({ runtime, agentDir });
    const cwd = await tempDir("pi-web-policy-project-");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({
      providers: { "project-acme": providerConfig("project-acme") },
    }));

    const session = await service.start(cwd);

    // The globally configured provider is honored; the project-level one is not.
    expect(runtime.getModel("global-acme", "model-1")).toBeDefined();
    expect(runtime.getModel("project-acme", "model-1")).toBeUndefined();
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    const status = await service.status({ id: session.id, cwd });
    expect((status.warnings ?? []).filter((warning) => warning.message.includes(POLICY_WORDING))).toEqual([]);
  });
});
