import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OAuthLoginFlowService", () => {
  it("round-trips prompt responses and completes the flow", async () => {
    let promptValue: string | undefined;
    const onComplete = vi.fn();
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: async (interaction) => {
        interaction.notify({ type: "auth_url", url: "https://example.test/auth", instructions: "Open it" });
        interaction.notify({ type: "progress", message: "Waiting for code" });
        promptValue = await interaction.prompt({ type: "text", message: "Paste code", placeholder: "code" });
        interaction.notify({ type: "progress", message: `Got ${promptValue}` });
      },
      onComplete,
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected prompt");
    expect(state).toMatchObject({ auth: { url: "https://example.test/auth" }, progress: ["Waiting for code"] });
    expect(prompt).toMatchObject({ message: "Paste code", placeholder: "code", kind: "text" });

    const afterRespond = service.respond(state.flowId, prompt.requestId, "abc123");
    expect(afterRespond.prompt).toBeUndefined();
    await flushAsyncLogin();

    expect(promptValue).toBe("abc123");
    expect(service.get(state.flowId)).toMatchObject({ status: "complete", progress: ["Waiting for code", "Got abc123", "Login complete"] });
    expect(onComplete).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("round-trips select responses", async () => {
    let selectedValue: string | undefined;
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: async (interaction) => {
        selectedValue = await interaction.prompt({
          type: "select",
          message: "Choose account",
          options: [{ id: "work", label: "Work", description: "Company account" }, { id: "personal", label: "Personal" }],
        });
      },
    });

    const select = state.select;
    if (select === undefined) throw new Error("Expected select prompt");
    expect(select).toMatchObject({ message: "Choose account", options: [{ value: "work", label: "Work", description: "Company account" }, { value: "personal", label: "Personal" }] });

    service.respond(state.flowId, select.requestId, "personal");
    await flushAsyncLogin();

    expect(selectedValue).toBe("personal");
    expect(service.get(state.flowId).status).toBe("complete");
    service.dispose();
  });

  it("preserves secret prompt semantics", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: async (interaction) => {
        await interaction.prompt({ type: "secret", message: "Enter secret", placeholder: "token" });
      },
    });

    expect(state.prompt).toMatchObject({ kind: "secret", message: "Enter secret", placeholder: "token" });
    service.dispose();
  });

  it("rejects values outside the pending select options", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: async (interaction) => {
        await interaction.prompt({
          type: "select",
          message: "Choose account",
          options: [{ id: "work", label: "Work" }],
        });
      },
    });

    const select = state.select;
    if (select === undefined) throw new Error("Expected select prompt");
    expect(() => { service.respond(state.flowId, select.requestId, "personal"); }).toThrow("Invalid OAuth selection");
    expect(service.get(state.flowId).select).toBeDefined();
    service.dispose();
  });

  it("preserves device-code timing metadata", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: async (interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://example.test/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        });
        await new Promise(() => undefined);
      },
    });

    expect(state.auth).toEqual({
      url: "https://example.test/device",
      instructions: "Enter code: ABCD-EFGH",
      deviceCode: { userCode: "ABCD-EFGH", intervalSeconds: 5, expiresInSeconds: 900 },
    });
    service.dispose();
  });

  it("awaits completion propagation before marking the flow complete", async () => {
    const completion = deferred<undefined>();
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: () => Promise.resolve(),
      onComplete: () => completion.promise,
    });

    await flushAsyncLogin();
    expect(service.get(state.flowId).status).toBe("running");

    completion.resolve(undefined);
    await flushAsyncLogin();
    expect(service.get(state.flowId).status).toBe("complete");
    service.dispose();
  });

  it("uses a manual-code prompt for callback-server flows", async () => {
    let manualValue: string | undefined;
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: async (interaction) => {
        manualValue = await interaction.prompt({ type: "manual_code", message: "Paste the callback URL or authorization code" });
      },
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected manual prompt");
    expect(prompt).toMatchObject({ kind: "manual-code", message: "Paste the callback URL or authorization code" });

    service.respond(state.flowId, prompt.requestId, "https://localhost/callback?code=abc");
    await flushAsyncLogin();

    expect(manualValue).toBe("https://localhost/callback?code=abc");
    expect(service.get(state.flowId).status).toBe("complete");
    service.dispose();
  });

  it("rejects pending prompts when cancelled", async () => {
    const promptRejected = deferred<Error>();
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: loginWithRejectedPrompt(promptRejected),
    });

    expect(state.prompt).toBeDefined();
    expect(service.cancel(state.flowId)).toMatchObject({ status: "cancelled", error: "Login cancelled" });

    await expect(promptRejected.promise).resolves.toMatchObject({ message: "Login cancelled" });
    expect(service.get(state.flowId).status).toBe("cancelled");
    service.dispose();
  });

  it("rejects pending prompts when disposed", async () => {
    const promptRejected = deferred<Error>();
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: loginWithRejectedPrompt(promptRejected),
    });

    expect(state.prompt).toBeDefined();
    service.dispose();

    await expect(promptRejected.promise).resolves.toMatchObject({ message: "Login cancelled" });
    expect(() => { service.get(state.flowId); }).toThrow("OAuth login flow not found");
  });

  it("rejects stale or duplicate responses", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: async (interaction) => {
        await interaction.prompt({ type: "text", message: "Paste code" });
      },
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected prompt");

    service.respond(state.flowId, prompt.requestId, "abc123");
    expect(() => { service.respond(state.flowId, prompt.requestId, "abc123"); }).toThrow("OAuth login request expired");
    service.dispose();
  });

  it("expires abandoned running flows and evicts terminal flows", async () => {
    vi.useFakeTimers();
    const promptRejected = deferred<Error>();
    const service = new OAuthLoginFlowService({ runningTtlMs: 1000, terminalTtlMs: 1000 });
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      login: loginWithRejectedPrompt(promptRejected),
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(service.get(state.flowId)).toMatchObject({ status: "error", error: "OAuth login flow expired" });
    await expect(promptRejected.promise).resolves.toMatchObject({ message: "OAuth login flow expired" });

    await vi.advanceTimersByTimeAsync(1000);

    expect(() => { service.get(state.flowId); }).toThrow("OAuth login flow not found");
    service.dispose();
  });
});

function loginWithRejectedPrompt(promptRejected: ReturnType<typeof deferred<Error>>) {
  return async (interaction: AuthInteraction) => {
    try {
      await interaction.prompt({ type: "text", message: "Paste code" });
    } catch (error) {
      promptRejected.resolve(toError(error));
      throw error;
    }
  };
}

async function flushAsyncLogin(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
