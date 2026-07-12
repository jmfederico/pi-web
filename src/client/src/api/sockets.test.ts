import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalSessionEvents, realtimeEvents, sessionEvents, terminalSocket } from "./sockets";

const webSocketUrls: string[] = [];

function FakeWebSocket(url: string): void {
  webSocketUrls.push(url);
}

beforeEach(() => {
  webSocketUrls.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "pi.example.test" });
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
      "api/machines/local/sessions/s1/events?cwd=%2Frepo",
      "api/machines/local/sessions/events",
      "api/machines/local/events",
    ]);
  });

  it("keeps legacy session socket urls usable without cwd", () => {
    sessionEvents("s1");

    expect(webSocketUrls).toEqual([
      "api/machines/local/sessions/s1/events",
    ]);
  });

  it("uses the requested machine scope for terminal sockets", () => {
    terminalSocket("p 1", "w/1", "t?1", { cols: 120, rows: 40 }, "remote-a");

    expect(webSocketUrls).toEqual([
      "api/machines/remote-a/projects/p%201/workspaces/w%2F1/terminals/t%3F1/socket?cols=120&rows=40",
    ]);
  });
});
