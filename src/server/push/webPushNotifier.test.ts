import { describe, expect, it, vi } from "vitest";
import type { SessionUiEvent } from "../../shared/apiTypes.js";
import { DEFAULT_PUSH_COOLDOWN_MS, PUSH_NOTIFICATION_BODY_MAX_CHARS, WebPushNotifier, pushMessageForSessionEvent, truncateForPush, type PushSender, type SessionDeepLinkTarget } from "./webPushNotifier.js";

function assistantMessage(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }] };
}

class FakeSubscriptionStore {
  readonly records = new Map<string, Record<string, string>>();
  readonly removed: string[] = [];

  constructor(endpoints: readonly string[]) {
    for (const endpoint of endpoints) this.records.set(endpoint, {});
  }

  list(): { endpoint: string; expirationTime?: number | null; keys: Readonly<Record<string, string>> }[] {
    return [...this.records.entries()].map(([endpoint, keys]) => ({ endpoint, keys }));
  }

  remove(endpoint: string): boolean {
    const removed = this.records.delete(endpoint);
    if (removed) this.removed.push(endpoint);
    return removed;
  }
}

interface Harness {
  notifier: WebPushNotifier;
  advance(by: number): void;
  sent: { endpoint: string; payload: string }[];
  errors: string[];
  store: FakeSubscriptionStore;
}

function createNotifier(send?: PushSender, options?: { cooldownMs?: number | undefined; resolveCwd?: ((sessionId: string) => string | undefined) | undefined; resolveDeepLink?: ((cwd: string) => Promise<SessionDeepLinkTarget | undefined> | SessionDeepLinkTarget | undefined) | undefined }): Harness {
  let clockValue = 0;
  const harnessErrors: string[] = [];
  const sentPayloads: { endpoint: string; payload: string }[] = [];
  const defaultSend: PushSender = (subscription, payload) => {
    sentPayloads.push({ endpoint: subscription.endpoint, payload });
    return Promise.resolve();
  };
  const store = new FakeSubscriptionStore(["https://push.example/svc/a"]);
  const notifier = new WebPushNotifier(send ?? defaultSend, {
    subscriptions: store,
    ...(options?.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options?.resolveCwd === undefined ? {} : { resolveCwd: options.resolveCwd }),
    ...(options?.resolveDeepLink === undefined ? {} : { resolveDeepLink: options.resolveDeepLink }),
    now: () => clockValue,
    onError: (message) => harnessErrors.push(message),
  });
  return { notifier, advance: (by) => { clockValue += by; }, sent: sentPayloads, errors: harnessErrors, store };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows the JSON payload the notifier sends, keeping the test free of `any` from JSON.parse. */
function sessionIdOfPayload(payload: string): string {
  const parsed: unknown = JSON.parse(payload);
  if (!isRecord(parsed) || !("data" in parsed)) throw new Error(`unexpected push payload: ${payload}`);
  const data = parsed["data"];
  if (!isRecord(data) || typeof data["sessionId"] !== "string") throw new Error(`unexpected push data: ${payload}`);
  return data["sessionId"];
}

describe("pushMessageForSessionEvent", () => {
  it("notifies for assistant completions with visible text", () => {
    const result = pushMessageForSessionEvent({ type: "message.end", message: assistantMessage("Done. The build is green.") } satisfies SessionUiEvent);
    expect(result).toEqual({ title: "PI WEB", body: "Done. The build is green.", kind: "message" });
  });

  it("stays silent for user messages, tool churn, and status events", () => {
    const quiet: SessionUiEvent[] = [
      { type: "message.end", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "message.append", message: assistantMessage("partial") },
      { type: "assistant.delta", text: "streaming" },
      { type: "tool.end", toolName: "bash", toolCallId: "t1", text: "output", isError: false },
    ];
    for (const event of quiet) expect(pushMessageForSessionEvent(event)).toBeUndefined();
  });

  it("stays silent when the assistant completion carries no visible text (thinking or tool-only turns)", () => {
    const events: SessionUiEvent[] = [
      { type: "message.end", message: undefined },
      { type: "message.end", message: { role: "assistant", content: [{ type: "thinking", text: "hmm" }] } },
      { type: "message.end", message: { role: "assistant", content: [] } },
      { type: "message.end", message: assistantMessage("   ") },
    ];
    for (const event of events) expect(pushMessageForSessionEvent(event)).toBeUndefined();
  });

  it("notifies session errors and flattens multi-line text into one bounded line", () => {
    const error = pushMessageForSessionEvent({ type: "session.error", message: "boom:\n\n    stack" } satisfies SessionUiEvent);
    expect(error).toEqual({ title: "PI WEB", body: "boom: stack", kind: "error" });

    const result = pushMessageForSessionEvent({ type: "message.end", message: assistantMessage(`keep ${"a".repeat(500)}`) } satisfies SessionUiEvent);
    expect(result?.body.length).toBeLessThanOrEqual(PUSH_NOTIFICATION_BODY_MAX_CHARS + 1); // ellipsis allowed
    expect(result?.kind).toBe("message");
  });
});

describe("truncateForPush", () => {
  it("collapses whitespace and keeps short text intact after normalization", () => {
    expect(truncateForPush("  line one\n\tline two  ")).toBe("line one line two");
  });

  it("breaks at a word boundary when one exists in the second half of the budget", () => {
    const body = truncateForPush(`${"word ".repeat(60)}end`);
    expect(body.endsWith("…")).toBe(true);
    // The last kept token is a complete word, proving the cut happened at a space.
    expect(body.slice(0, -1).trimEnd().endsWith("word")).toBe(true);
  });

  it("never exceeds budget plus ellipsis even without a boundary", () => {
    const body = truncateForPush(`${"a".repeat(PUSH_NOTIFICATION_BODY_MAX_CHARS + 5)}b`);
    expect(body.length).toBeLessThanOrEqual(PUSH_NOTIFICATION_BODY_MAX_CHARS + 1);
  });
});

describe("WebPushNotifier", () => {
  it("delivers the notification payload with session data to every subscription", async () => {
    const harness = createNotifier();
    harness.notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("final answer") });
    await settle();
    expect(harness.sent).toHaveLength(1);
    expect(JSON.parse(harness.sent[0]?.payload ?? "{}")).toEqual({ title: "PI WEB", body: "final answer", data: { kind: "message", sessionId: "s1" } });
  });

  it("carries the session cwd in the payload so the browser can resolve the deep-link route", async () => {
    const harness = createNotifier(undefined, { resolveCwd: (sessionId) => (sessionId === "s1" ? "/repo/app" : undefined) });
    harness.notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("done") });
    await settle();
    expect(JSON.parse(harness.sent[0]?.payload ?? "{}")).toEqual({ title: "PI WEB", body: "done", data: { kind: "message", sessionId: "s1", cwd: "/repo/app" } });
  });

  it("carries daemon-resolved canonical route ids so the service worker can link without a cwd join", async () => {
    const resolveDeepLink = vi.fn((cwd: string): SessionDeepLinkTarget | undefined => (cwd === "/repo/app" ? { projectId: "p1", workspaceId: "w1id12345678" } : undefined));
    const harness = createNotifier(undefined, { resolveCwd: () => "/repo/app", resolveDeepLink });
    harness.notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("done") });
    await settle();
    expect(resolveDeepLink).toHaveBeenCalledWith("/repo/app");
    expect(JSON.parse(harness.sent[0]?.payload ?? "{}")).toEqual({ title: "PI WEB", body: "done", data: { kind: "message", sessionId: "s1", cwd: "/repo/app", projectId: "p1", workspaceId: "w1id12345678" } });
  });

  it("degrades to the cwd-only payload when the deep-link resolver fails", async () => {
    const harness = createNotifier(undefined, { resolveCwd: () => "/repo/app", resolveDeepLink: () => Promise.reject(new Error("projects.json unreadable")) });
    harness.notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("done") });
    await settle();
    // The notification must still go out, exactly like a daemon without the resolver.
    expect(harness.sent).toHaveLength(1);
    expect(JSON.parse(harness.sent[0]?.payload ?? "{}")).toEqual({ title: "PI WEB", body: "done", data: { kind: "message", sessionId: "s1", cwd: "/repo/app" } });
  });

  it("coalesces bursts within the cooldown window per session but not across sessions", async () => {
    const harness = createNotifier();
    for (const sessionId of ["s1", "s2"]) {
      harness.notifier.onSessionEvent(sessionId, { type: "message.end", message: assistantMessage("one") });
      harness.advance(1_000);
      harness.notifier.onSessionEvent(sessionId, { type: "message.end", message: assistantMessage("two") }); // throttled per session
    }
    await settle();
    expect(harness.sent.map((entry) => sessionIdOfPayload(entry.payload))).toEqual(["s1", "s2"]);

    harness.advance(DEFAULT_PUSH_COOLDOWN_MS);
    harness.notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("three") });
    await settle();
    expect(harness.sent).toHaveLength(3);
  });

  it("removes subscriptions the push service reports expired and logs other failures separately", async () => {
    const store = new FakeSubscriptionStore(["https://push.example/svc/gone", "https://push.example/svc/live"]);
    const errors: string[] = [];
    const flakySend: PushSender = (subscription) => {
      if (subscription.endpoint.endsWith("/gone")) return Promise.reject(Object.assign(new Error("Gone"), { statusCode: 410 }));
      return Promise.reject(Object.assign(new Error("overloaded"), { statusCode: 503 }));
    };
    const notifier = new WebPushNotifier(flakySend, { subscriptions: store, onError: (message) => {
      errors.push(message);
    }, now: () => 1 });
    notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("retry me") });
    await settle();
    expect(store.removed).toEqual(["https://push.example/svc/gone"]);
    expect(errors.some((line) => line.includes('removed 1 expired push subscription'))).toBe(true);
    expect(errors.some((line) => line.includes('delivery failed for 1 of 2 subscriptions'))).toBe(true);
  });

  it("never rejects into the hub when delivery itself throws unexpectedly", async () => {
    const store = new FakeSubscriptionStore(["https://push.example/svc/a"]);
    const errors: string[] = [];
    const throwingSend: PushSender = () => {
      return Promise.reject(new Error("boom"));
    };
    const notifier = new WebPushNotifier(throwingSend, { subscriptions: store, onError: (message) => {
      errors.push(message);
    }, now: () => 1 });
    expect(() => { notifier.onSessionEvent("s1", { type: "session.error", message: "dead" }); }).not.toThrow();
    await settle();
    expect(errors.some((line) => line.includes('delivery failed for 1 of 1 subscriptions'))).toBe(true);
  });

  it("treats a synchronous sender throw like a rejection so the hub never sees a throw", async () => {
    const store = new FakeSubscriptionStore(["https://push.example/svc/a"]);
    const errors: string[] = [];
    const syncThrowSend: PushSender = () => {
      throw new Error("sync boom");
    };
    const notifier = new WebPushNotifier(syncThrowSend, { subscriptions: store, onError: (message) => {
      errors.push(message);
    }, now: () => 1 });
    expect(() => {
      notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("x") });
    }).not.toThrow();
    await settle();
    expect(errors.some((line) => line.includes("delivery failed for 1 of 1 subscriptions"))).toBe(true);
  });

  it("skips delivery entirely when nothing is subscribed", async () => {
    const send = vi.fn<PushSender>();
    const harness = createNotifier(send);
    harness.store.records.clear();
    harness.notifier.onSessionEvent("s1", { type: "message.end", message: assistantMessage("nobody home") });
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("wires through the event source seam and honors unsubscribe", async () => {
    const harness = createNotifier();
    let listenerCalls = 0;
    const listenerSeen = (): void => { listenerCalls += 1; };
    let capturedListener: ((sessionId: string, event: SessionUiEvent) => void) | undefined;
    const stop = harness.notifier.subscribeToEvents({
      subscribe(listener) {
        capturedListener = listener;
        return () => { listenerSeen(); };
      },
    });
    expect(capturedListener).toBeTypeOf("function");
    capturedListener?.("s9", { type: "message.end", message: assistantMessage("via hub") });
    await settle();
    expect(harness.sent).toHaveLength(1);
    stop();
    expect(listenerCalls).toBe(1);
  });
});
