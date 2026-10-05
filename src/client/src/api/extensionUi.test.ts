import { describe, expect, it } from "vitest";
import { parseSessionStatus } from "./parsers";

const sessionStatus = {
  sessionId: "session-1",
  isStreaming: false,
  isCompacting: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

describe("session status extension UI parser", () => {
  it("preserves optional working messages and rejects invalid or oversized values", () => {
    const extensionUi = { statuses: {}, widgets: {}, workingMessage: "Consulting the rubber duck" };
    expect(parseSessionStatus({ ...sessionStatus, extensionUi }).extensionUi).toEqual(extensionUi);
    for (const workingMessage of [null, 42, {}, "x".repeat(513)]) {
      expect(() => parseSessionStatus({ ...sessionStatus, extensionUi: { ...extensionUi, workingMessage } })).toThrow("Invalid extension UI working message");
    }
  });

  it("accepts legacy status payloads without extensionUi", () => {
    const parsed = parseSessionStatus(sessionStatus);

    expect(parsed).toEqual({ ...sessionStatus, recentlyActiveElsewhere: false });
    expect(parsed.extensionUi).toBeUndefined();
  });

  it("parses bounded status strings and string-array widgets", () => {
    const extensionUi = {
      statuses: { worker: "running" },
      widgets: { "subagent-async": ["PI_SUBAGENT_ASYNC_JSON:{\"version\":1}"] },
    };

    expect(parseSessionStatus({ ...sessionStatus, extensionUi }).extensionUi).toEqual(extensionUi);
  });

  it("rejects prototype-sensitive keys, private widgets, and oversized values", () => {
    const privateWidget = { statuses: {}, widgets: { "subagent-inspect": ["PI_SUBAGENT_INSPECT_JSON: private"] } };
    const prototypeStatuses = Object.defineProperty({}, "__proto__", { value: "unsafe", enumerable: true });
    const prototypeStatus = { statuses: prototypeStatuses, widgets: {} };

    expect(() => parseSessionStatus({ ...sessionStatus, extensionUi: privateWidget })).toThrow("Private extension UI widget");
    expect(() => parseSessionStatus({ ...sessionStatus, extensionUi: prototypeStatus })).toThrow("Invalid extension UI key");
    expect(() => parseSessionStatus({
      ...sessionStatus,
      extensionUi: { statuses: { ["k".repeat(129)]: "value" }, widgets: {} },
    })).toThrow("Invalid extension UI key");
    expect(() => parseSessionStatus({
      ...sessionStatus,
      extensionUi: { statuses: { worker: "x".repeat(513) }, widgets: {} },
    })).toThrow("Invalid extension UI status value");
    expect(() => parseSessionStatus({
      ...sessionStatus,
      extensionUi: { statuses: {}, widgets: { plugin: ["x".repeat(33_001)] } },
    })).toThrow("Invalid extension UI widget lines");
  });
});
