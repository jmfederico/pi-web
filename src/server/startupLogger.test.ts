import Fastify from "fastify";
import { expect, it } from "vitest";
import { startupLogger } from "./startupLogger.js";

it("suppresses Fastify listening logs without suppressing requests, warnings, or errors", async () => {
  const messages: string[] = [];
  const app = Fastify({
    logger: { ...startupLogger, stream: { write: (message) => { messages.push(message); } } },
  });
  app.get("/", () => ({ ok: true }));
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    expect(messages).toEqual([]);
    await app.inject({ url: "/" });
    app.log.info("ordinary information");
    app.log.warn("a warning");
    app.log.error("an error");
    // Even a matching message at an error level must remain visible.
    app.log.error("Server listening at unexpected address");
    const output = messages.join("");
    expect(output).toContain("incoming request");
    expect(output).toContain("request completed");
    expect(output).toContain("ordinary information");
    expect(output).toContain("a warning");
    expect(output).toContain("an error");
    expect(output).toContain("Server listening at unexpected address");
  } finally {
    await app.close();
  }
});
