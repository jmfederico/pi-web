import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

type LoginHandler = (providerId: string, interaction: AuthInteraction) => Promise<void>;

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
      runtime: fakeRuntime(async (_providerId, interaction) => {
        interaction.notify({ type: "auth_url", url: "https://example.test/auth", instructions: "Open it" });
        interaction.notify({ type: "progress", message: "Waiting for code" });
        promptValue = await interaction.prompt({ type: "text", message: "Paste code", placeholder: "code" });
        interaction.notify({ type: "progress", message: `Got ${promptValue}` });
      }),
      onComplete,
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected prompt");
    expect(state).toMatchObject({ auth: { url: "https://example.test/auth", instructions: "Open it" }, progress: ["Waiting for code"] });
    expect(prompt).toMatchObject({ message: "Paste code", placeholder: "code", kind: "prompt", promptType: "text", allowEmpty: true });

    const afterRespond = service.respond(state.flowId, prompt.requestId, "abc123");
    expect(afterRespond.prompt).toBeUndefined();
    await flushAsyncLogin();

    expect(promptValue).toBe("abc123");
    expect(service.get(state.flowId)).toMatchObject({ status: "complete", progress: ["Waiting for code", "Got abc123", "Login complete"] });
    expect(onComplete).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("runs API-key login through the same AuthInteraction transport", async () => {
    const authTypes: AuthType[] = [];
    let key: string | undefined;
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        key = await interaction.prompt({ type: "secret", message: "Enter API key" });
      }, authTypes),
      authType: "api_key",
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected API-key prompt");
    service.respond(state.flowId, prompt.requestId, "sk-test");
    await flushAsyncLogin();

    expect(authTypes).toEqual(["api_key"]);
    expect(key).toBe("sk-test");
    expect(service.get(state.flowId).status).toBe("complete");
    service.dispose();
  });

  it("awaits async completion propagation before marking the flow complete", async () => {
    const completion = deferred<undefined>();
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(() => Promise.resolve()),
      onComplete: () => completion.promise,
    });

    await flushAsyncLogin();
    expect(service.get(state.flowId).status).toBe("running");

    completion.resolve(undefined);
    await flushAsyncLogin();
    expect(service.get(state.flowId).status).toBe("complete");
    service.dispose();
  });

  it("keeps a committed login complete when its completion callback and logger throw", async () => {
    const completionFailure = new Error("completion propagation failed");
    const loggingFailure = new Error("OAuth logger failed");
    const error = vi.fn(() => { throw loggingFailure; });
    const onComplete = vi.fn(() => { throw completionFailure; });
    const service = new OAuthLoginFlowService({ logger: { error } });
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(() => Promise.resolve()),
      onComplete,
    });

    await vi.waitFor(() => { expect(service.get(state.flowId).status).toBe("complete"); });

    expect(service.get(state.flowId)).toMatchObject({ status: "complete", progress: ["Login complete"] });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      { err: completionFailure, flowId: state.flowId, providerId: "test-provider" },
      "login completion callback failed",
    );
    service.dispose();
  });

  it("allows blank text responses for providers that use blank as a default", async () => {
    let domain: string | undefined;
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "github-copilot",
      providerName: "GitHub Copilot",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        domain = await interaction.prompt({
          type: "text",
          message: "GitHub Enterprise URL/domain (blank for github.com)",
        });
      }),
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected text prompt");
    expect(prompt).toMatchObject({ kind: "prompt", promptType: "text", allowEmpty: true });

    service.respond(state.flowId, prompt.requestId, "");
    await flushAsyncLogin();

    expect(domain).toBe("");
    expect(service.get(state.flowId).status).toBe("complete");
    service.dispose();
  });

  it("preserves secret prompt semantics behind the legacy prompt kind", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        await interaction.prompt({ type: "secret", message: "Enter secret", placeholder: "token" });
      }),
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected secret prompt");
    expect(prompt).toMatchObject({
      kind: "prompt",
      promptType: "secret",
      message: "Enter secret",
      placeholder: "token",
    });
    expect(prompt).not.toHaveProperty("allowEmpty");
    expect(() => { service.respond(state.flowId, prompt.requestId, ""); }).toThrow("A value is required");
    service.dispose();
  });

  it("preserves info-event links without replacing the authorization URL", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        interaction.notify({ type: "auth_url", url: "https://example.test/login" });
        interaction.notify({
          type: "info",
          message: "Review the provider setup guide",
          links: [{ url: "https://example.test/docs", label: "Setup guide" }],
        });
        await interaction.prompt({ type: "text", message: "Continue" });
      }),
    });

    expect(state).toMatchObject({
      auth: { url: "https://example.test/login" },
      progress: ["Review the provider setup guide"],
      info: [{ message: "Review the provider setup guide", links: [{ url: "https://example.test/docs", label: "Setup guide" }] }],
    });
    service.dispose();
  });

  it("surfaces device-code events through the auth field", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: "WXYZ-1234",
          verificationUri: "https://example.test/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        });
        await interaction.prompt({ type: "text", message: "Waiting" });
      }),
    });

    expect(service.get(state.flowId)).toMatchObject({
      auth: {
        url: "https://example.test/device",
        instructions: "Enter code: WXYZ-1234",
        deviceCode: { userCode: "WXYZ-1234", intervalSeconds: 5, expiresInSeconds: 900 },
      },
    });
    service.dispose();
  });

  it("round-trips select responses", async () => {
    let selectedValue: string | undefined;
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        selectedValue = await interaction.prompt({
          type: "select",
          message: "Choose account",
          options: [{ id: "work", label: "Work", description: "Company account" }, { id: "personal", label: "Personal" }],
        });
      }),
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

  it("rejects responses outside the pending select options", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        await interaction.prompt({
          type: "select",
          message: "Choose account",
          options: [{ id: "work", label: "Work" }],
        });
      }),
    });

    const select = state.select;
    if (select === undefined) throw new Error("Expected select prompt");
    expect(() => { service.respond(state.flowId, select.requestId, "personal"); }).toThrow("Invalid login selection");
    expect(service.get(state.flowId).select).toEqual(select);
    service.dispose();
  });

  it("uses a manual-code prompt for callback-server flows and cleans up its abort listener", async () => {
    let manualValue: string | undefined;
    const service = new OAuthLoginFlowService();
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        manualValue = await interaction.prompt({
          type: "manual_code",
          message: "Paste the callback URL or authorization code",
          signal: controller.signal,
        });
      }),
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected manual prompt");
    expect(prompt).toMatchObject({ kind: "manual", promptType: "manual_code", message: "Paste the callback URL or authorization code" });

    service.respond(state.flowId, prompt.requestId, "https://localhost/callback?code=abc");
    await flushAsyncLogin();

    expect(manualValue).toBe("https://localhost/callback?code=abc");
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(service.get(state.flowId).status).toBe("complete");
    service.dispose();
  });

  it("rejects a pending prompt when its own signal aborts without ending the flow", async () => {
    const promptRejected = deferred<Error>();
    const service = new OAuthLoginFlowService();
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        try {
          await interaction.prompt({ type: "manual_code", message: "Paste code", signal: controller.signal });
        } catch (error) {
          promptRejected.resolve(toError(error));
        }
        // The flow keeps running (e.g. the callback server resolves it) until we
        // resolve the follow-up prompt below.
        await interaction.prompt({ type: "text", message: "Waiting for callback" });
      }),
    });

    expect(state.prompt).toMatchObject({ kind: "manual" });
    controller.abort();
    await expect(promptRejected.promise).resolves.toMatchObject({ message: "Prompt cancelled" });
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));

    const afterAbort = service.get(state.flowId);
    expect(afterAbort.status).toBe("running");
    expect(afterAbort.prompt).toMatchObject({ kind: "prompt", message: "Waiting for callback" });
    service.dispose();
  });

  it("rejects pending prompts when cancelled", async () => {
    const promptRejected = deferred<Error>();
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        try {
          await interaction.prompt({ type: "text", message: "Paste code" });
        } catch (error) {
          promptRejected.resolve(toError(error));
          throw error;
        }
      }),
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
      runtime: fakeRuntime(async (_providerId, interaction) => {
        try {
          await interaction.prompt({ type: "text", message: "Paste code" });
        } catch (error) {
          promptRejected.resolve(toError(error));
          throw error;
        }
      }),
    });

    expect(state.prompt).toBeDefined();

    service.dispose();

    await expect(promptRejected.promise).resolves.toMatchObject({ message: "Login cancelled" });
    expect(() => { service.get(state.flowId); }).toThrow("Login flow not found");
  });

  it("rejects stale or duplicate responses", () => {
    const service = new OAuthLoginFlowService();
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        await interaction.prompt({ type: "text", message: "Paste code" });
      }),
    });

    const prompt = state.prompt;
    if (prompt === undefined) throw new Error("Expected prompt");

    service.respond(state.flowId, prompt.requestId, "abc123");
    expect(() => { service.respond(state.flowId, prompt.requestId, "abc123"); }).toThrow("Login request expired");
    service.dispose();
  });

  it("expires abandoned running flows and evicts terminal flows", async () => {
    vi.useFakeTimers();
    const promptRejected = deferred<Error>();
    const service = new OAuthLoginFlowService({ runningTtlMs: 1000, terminalTtlMs: 1000 });
    const state = service.start({
      providerId: "test-provider",
      providerName: "Test Provider",
      runtime: fakeRuntime(async (_providerId, interaction) => {
        try {
          await interaction.prompt({ type: "text", message: "Paste code" });
        } catch (error) {
          promptRejected.resolve(toError(error));
          throw error;
        }
      }),
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(service.get(state.flowId)).toMatchObject({ status: "error", error: "Login flow expired" });
    await expect(promptRejected.promise).resolves.toMatchObject({ message: "Login flow expired" });

    await vi.advanceTimersByTimeAsync(1000);

    expect(() => { service.get(state.flowId); }).toThrow("Login flow not found");
    service.dispose();
  });
});

function fakeRuntime(login: LoginHandler, authTypes?: AuthType[]): Pick<ModelRuntime, "login"> {
  return {
    login: (providerId, type, interaction) => {
      authTypes?.push(type);
      return login(providerId, interaction).then(() => type === "api_key"
        ? { type: "api_key", key: "test" }
        : { type: "oauth", refresh: "r", access: "a", expires: 0 });
    },
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
