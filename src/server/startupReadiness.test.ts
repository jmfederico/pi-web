import Fastify from "fastify";
import { expect, it, onTestFinished, vi } from "vitest";
import { startupLogger } from "./startupLogger.js";
import { reportStartupReadiness } from "./startupReadiness.js";

async function listenAndReport(isTTY: boolean | undefined) {
  const messages: string[] = [];
  const app = Fastify({ logger: { ...startupLogger, stream: { write: (message) => { messages.push(message); } } } });
  onTestFinished(() => app.close());
  const banner = vi.spyOn(console, "log").mockImplementation(() => undefined);
  onTestFinished(() => { banner.mockRestore(); });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  reportStartupReadiness(app, isTTY);
  return { messages, banner, origin };
}

it("emits one structured info event with the bound TCP endpoint on piped stdout", async () => {
  const { messages, banner, origin } = await listenAndReport(undefined);
  expect(banner).not.toHaveBeenCalled();
  expect(messages).toHaveLength(1);
  expect(JSON.parse(messages.join(""))).toMatchObject({
    level: 30, event: "web.ready", address: "127.0.0.1", port: Number(new URL(origin).port),
  });
});

it("prints only the existing URL banner on interactive stdout", async () => {
  const { messages, banner, origin } = await listenAndReport(true);
  expect(messages).toEqual([]);
  expect(banner).toHaveBeenCalledExactlyOnceWith(`\n  PI WEB is ready\n\n  Local: ${origin}\n`);
});
