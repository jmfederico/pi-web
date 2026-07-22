import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installGlobalProviderPolicy, providerRejectionMessage } from "./globalProviderPolicy.js";
import { createTestModelRuntime, TEST_MODEL_ID, TEST_MODEL_PROVIDER } from "./piSessionService.testSupport.js";

/**
 * The shim permanently mutates the runtime instance it is installed on, so
 * every test builds a dedicated runtime rather than touching the shared
 * `testModelRuntime` from testSupport.
 */
async function policyRuntime(): Promise<{ runtime: ModelRuntime; rejections: string[] }> {
  const runtime = await createTestModelRuntime();
  const rejections: string[] = [];
  installGlobalProviderPolicy(runtime, (providerId) => { rejections.push(providerId); });
  return { runtime, rejections };
}

describe("installGlobalProviderPolicy", () => {
  it("swallows registrations and records each rejection", async () => {
    const { runtime, rejections } = await policyRuntime();

    runtime.registerProvider("acme", { baseUrl: "https://acme.example.com" });
    runtime.registerProvider("acme", { baseUrl: "https://acme-two.example.com" });
    runtime.registerProvider("other", {});

    expect(rejections).toEqual(["acme", "acme", "other"]);
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(runtime.getRegisteredProviderConfig("acme")).toBeUndefined();
  });

  it("makes unregisterProvider a no-op that cannot remove global providers", async () => {
    const { runtime, rejections } = await policyRuntime();

    runtime.unregisterProvider("acme");
    runtime.unregisterProvider(TEST_MODEL_PROVIDER);

    expect(rejections).toEqual([]);
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBeDefined();
  });

  it("keeps global (built-in) providers resolvable after rejections", async () => {
    const { runtime } = await policyRuntime();
    const before = runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);

    runtime.registerProvider("acme", {});

    expect(before).toBeDefined();
    expect(runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBe(before);
  });
});

describe("providerRejectionMessage", () => {
  it("names the provider and the loading workspace when the cwd is known", () => {
    const message = providerRejectionMessage("acme", "/workspace/project");

    expect(message).toContain('Provider "acme"');
    expect(message).toContain("in /workspace/project");
    expect(message).toContain("PI WEB only supports globally configured providers");
    expect(message).toContain("All other extension features are unaffected.");
  });

  it("falls back to a generic origin for late registrations without a cwd", () => {
    const message = providerRejectionMessage("acme");

    expect(message).toContain('Provider "acme" registered by an extension was ignored');
    expect(message).not.toContain(" in ");
  });
});
