import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalSessionEvents, realtimeEvents, sessionEvents } from "./sockets";

const webSocketUrls: string[] = [];

function FakeWebSocket(url: string): void {
  webSocketUrls.push(url);
}

beforeEach(() => {
  webSocketUrls.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("machine-scoped socket urls", () => {
  it("defaults session sockets to the local machine scope", () => {
    sessionEvents({ id: "s1", cwd: "/repo" });
    globalSessionEvents();
    realtimeEvents();

    expect(webSocketUrls).toEqual([
      "wss://pi.example.test/api/machines/local/sessions/s1/events?cwd=%2Frepo",
      "wss://pi.example.test/api/machines/local/sessions/events",
      "wss://pi.example.test/api/machines/local/events",
    ]);
  });
});
