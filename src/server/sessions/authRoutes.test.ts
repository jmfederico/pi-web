import Fastify, { type FastifyInstance } from "fastify";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../../piSdk.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionResponse } from "../../shared/apiTypes.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { AuthService } from "./authService.js";

let app: FastifyInstance;
let auth: AuthService;
let runtime: ModelRuntime;
let credentials: InMemoryCredentialStore;

beforeEach(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", () => Promise.resolve({ type: "api_key", key: "secret-test-key" }));
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  auth = await AuthService.create({ runtime });
  app = Fastify({ logger: false });
  // This is the daemon's registration, without any session service or active session.
  registerAuthRoutes(app, auth);
});

afterEach(async () => {
  await app.close();
  auth.dispose();
  vi.unstubAllEnvs();
});

describe("machine-global GET /models", () => {
  it("returns available chat model selection metadata from the shared runtime without credentials", async () => {
    const refresh = vi.spyOn(runtime, "refresh");
    const response = await app.inject({ method: "GET", url: "/models" });

    expect(response.statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
    expect(response.json()).toEqual({
      models: runtime.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
      })),
    });
    expect(response.json<ModelSelectionResponse>().models).toContainEqual(expect.objectContaining({ provider: "anthropic" }));
    expect(response.body).not.toContain("secret-test-key");
    expect(response.body).not.toContain("baseUrl");
  });

  it("refreshes availability after credentials change rather than returning every catalog model", async () => {
    expect(runtime.getModels("anthropic").length).toBeGreaterThan(0);
    await credentials.delete("anthropic");

    const response = await app.inject({ method: "GET", url: "/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json<ModelSelectionResponse>().models).not.toContainEqual(expect.objectContaining({ provider: "anthropic" }));
    expect(runtime.getModels("anthropic").length).toBeGreaterThan(0);
  });

  it("does not disguise runtime refresh failures as an empty successful catalog", async () => {
    vi.spyOn(runtime, "refresh").mockRejectedValue(new Error("catalog unavailable"));

    const response = await app.inject({ method: "GET", url: "/models" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ message: "catalog unavailable" });
  });
});
