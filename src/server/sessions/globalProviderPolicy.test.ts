import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { installGlobalProviderPolicy, providerRejectionMessage } from "./globalProviderPolicy.js";
import { createTestModelRuntime, TEST_MODEL_ID, TEST_MODEL_PROVIDER } from "./piSessionService.testSupport.js";

/**
 * The shim permanently mutates the runtime instance it is installed on, so
 * every test builds a dedicated runtime rather than touching the shared
 * `testModelRuntime` from testSupport.
 */
async function policyRuntime(
  allowedExtensionProviderIds: ReadonlySet<string> = new Set(),
): Promise<{ runtime: ModelRuntime; rejections: string[] }> {
  const runtime = await createTestModelRuntime();
  const rejections: string[] = [];
  installGlobalProviderPolicy(runtime, allowedExtensionProviderIds, (providerId) => { rejections.push(providerId); });
  return { runtime, rejections };
}

function nativeProvider(providerId: string): Provider {
  return {
    id: providerId,
    name: providerId,
    auth: {
      apiKey: {
        name: `${providerId} API key`,
        resolve: () => Promise.resolve(undefined),
      },
    },
    getModels: () => [],
    stream: () => { throw new Error("stream should not be called in this test"); },
    streamSimple: () => { throw new Error("streamSimple should not be called in this test"); },
  };
}

describe("installGlobalProviderPolicy", () => {
  it("rejects non-allowed registrations and records each rejection", async () => {
    const { runtime, rejections } = await policyRuntime();

    runtime.registerProvider("acme", { baseUrl: "https://acme.example.com" });
    runtime.registerProvider("acme", { baseUrl: "https://acme-two.example.com" });
    runtime.registerProvider("other", {});

    expect(rejections).toEqual(["acme", "acme", "other"]);
    expect(runtime.getRegisteredProviderIds()).toEqual([]);
    expect(runtime.getRegisteredProviderConfig("acme")).toBeUndefined();
  });

  it("lets allowed (global-extension) providers through to the runtime", async () => {
    const { runtime, rejections } = await policyRuntime(new Set(["tensorx"]));

    runtime.registerProvider("tensorx", { baseUrl: "https://tensorx.example.com" });
    runtime.registerProvider("acme", { baseUrl: "https://acme.example.com" });

    expect(rejections).toEqual(["acme"]);
    expect(runtime.getRegisteredProviderIds()).toEqual(["tensorx"]);
    expect(runtime.getRegisteredProviderConfig("tensorx")).toEqual({ baseUrl: "https://tensorx.example.com" });
  });

  it("applies the same allow rule to native provider registrations", async () => {
    const { runtime, rejections } = await policyRuntime(new Set(["native-global"]));

    runtime.registerNativeProvider(nativeProvider("native-global"));
    runtime.registerNativeProvider(nativeProvider("native-project"));

    expect(rejections).toEqual(["native-project"]);
    expect(runtime.getRegisteredProviderIds()).toEqual(["native-global"]);
    expect(runtime.getRegisteredNativeProvider("native-global")).toBeDefined();
  });

  it("unregisters only allowed providers; other unregisters are a no-op", async () => {
    const { runtime, rejections } = await policyRuntime(new Set(["tensorx"]));
    runtime.registerProvider("tensorx", { baseUrl: "https://tensorx.example.com" });

    runtime.unregisterProvider("acme");
    runtime.unregisterProvider(TEST_MODEL_PROVIDER);
    expect(runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID)).toBeDefined();

    runtime.unregisterProvider("tensorx");

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
    expect(message).toContain("PI WEB providers must come from global configuration");
    expect(message).toContain("globally installed extension");
    expect(message).toContain("All other extension features are unaffected.");
  });

  it("falls back to a generic origin for late registrations without a cwd", () => {
    const message = providerRejectionMessage("acme");

    expect(message).toContain('Provider "acme" registered by an extension was ignored');
    expect(message).not.toContain(" in ");
  });
});
