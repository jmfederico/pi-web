import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { QueuedSessionMessage, SessionQueueMessageMutation } from "../../shared/apiTypes.js";

export type QueueAgent = Pick<Agent, "steeringMode" | "followUpMode" | "peekQueuedMessages" | "clearSteeringQueue" | "clearAllQueues" | "steer" | "followUp">;

const incompatibilityReason = "Queue message controls are unavailable because this Pi SDK queue interface is incompatible.";
let inspectionSequence = 0;

/** Fail closed for one runtime, without taking its public session operations down. */
export class QueueCompatibilityGuard<Runtime extends object> {
  private readonly failures = new WeakMap<Runtime, string>();

  constructor(private readonly onFailure: (runtime: Runtime, error: unknown) => void) {}

  reason(runtime: Runtime): string | undefined { return this.failures.get(runtime); }

  assertAvailable(runtime: Runtime): void {
    const reason = this.reason(runtime);
    if (reason !== undefined) throw new Error(reason);
  }

  run<T>(runtime: Runtime, operation: () => T): T {
    this.assertAvailable(runtime);
    try { return operation(); }
    catch (error) {
      this.failures.set(runtime, incompatibilityReason);
      this.onFailure(runtime, error);
      throw new Error(incompatibilityReason, { cause: error });
    }
  }

  inspect<T>(runtime: Runtime, operation: () => T, fallback: () => T): T {
    if (this.reason(runtime) !== undefined) return fallback();
    try { return this.run(runtime, operation); }
    catch { return fallback(); }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueuedMessage(value: unknown): value is QueuedSessionMessage {
  return isRecord(value) && (value["kind"] === "steer" || value["kind"] === "followUp") && typeof value["text"] === "string"
    && (value["hasAttachments"] === undefined || typeof value["hasAttachments"] === "boolean")
    && (value["attachmentCount"] === undefined || (typeof value["attachmentCount"] === "number" && Number.isSafeInteger(value["attachmentCount"]) && value["attachmentCount"] >= 0));
}

export function parseQueueMessageMutation(value: unknown): SessionQueueMessageMutation {
  if (!isRecord(value)) throw new Error("Queue mutation is required");
  const { action, index, expectedQueue } = value;
  if (action !== "remove" && action !== "edit" && action !== "toggle") throw new Error("Invalid queue action");
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new Error("Invalid queue index");
  if (!Array.isArray(expectedQueue) || !expectedQueue.every(isQueuedMessage)) throw new Error("Invalid expected queue");
  return { action, index, expectedQueue: expectedQueue.map(({ kind, text, hasAttachments, attachmentCount }) => ({ kind, text, ...(hasAttachments === undefined ? {} : { hasAttachments }), ...(attachmentCount === undefined ? {} : { attachmentCount }) })) };
}

function isQueueMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value["role"] !== "string") return false;
  if (value["role"] !== "user") return true; // Opaque extension/tool messages are preserved, not interpreted.
  const content = value["content"];
  return typeof content === "string" || (Array.isArray(content) && content.every((part: unknown) => isRecord(part)
    && typeof part["type"] === "string" && (part["type"] !== "text" || typeof part["text"] === "string")));
}

function queueModes(agent: QueueAgent): { steer: QueueAgent["steeringMode"]; followUp: QueueAgent["followUpMode"] } {
  return { steer: agent.steeringMode, followUp: agent.followUpMode };
}

function readQueue(agent: QueueAgent): AgentMessage[] {
  const value: unknown = agent.peekQueuedMessages();
  if (!Array.isArray(value) || !value.every(isQueueMessage)) throw new Error("SDK queue inspection returned invalid messages");
  return [...value];
}

/** No awaits: the agent loop cannot consume queues between snapshot and rebuild. */
export function snapshotAgentQueues(agent: QueueAgent): { steer: AgentMessage[]; followUp: AgentMessage[] } {
  const steeringMode = agent.steeringMode;
  const followUpMode = agent.followUpMode;
  const sentinel: AgentMessage = { role: "user", content: `pi-web-queue-inspection-${String(++inspectionSequence)}`, timestamp: 0 };
  let steer: AgentMessage[] | undefined;
  try {
    agent.steeringMode = "all";
    agent.followUpMode = "all";
    const modes = queueModes(agent);
    if (modes.steer !== "all" || modes.followUp !== "all") throw new Error("SDK queue modes are not writable");
    // Validate the return signature before touching any queued messages.
    if (readQueue(agent).length === 0) return { steer: [], followUp: [] };
    agent.steer(sentinel);
    const selected = readQueue(agent);
    const last = selected.at(-1);
    if (last !== sentinel) {
      // If inspection now returns copies, remove the recognizable probe during
      // rollback, but still disable operations that assumed SDK object identity.
      if (last?.role === "user" && last.content === sentinel.content && last.timestamp === 0) steer = selected.slice(0, -1);
      throw new Error("SDK queue inspection no longer preserves queued message identity");
    }
    steer = selected.slice(0, -1);
    agent.clearSteeringQueue();
    return { steer, followUp: readQueue(agent) };
  } finally {
    // Never clear originals when inspection failed before a trustworthy snapshot.
    try {
      if (steer !== undefined) {
        agent.clearSteeringQueue();
        for (const message of steer) agent.steer(message);
      }
    } finally {
      try { agent.steeringMode = steeringMode; }
      finally { agent.followUpMode = followUpMode; }
    }
  }
}

export function hasQueueApi(agent: Partial<QueueAgent>): agent is QueueAgent {
  return [agent.peekQueuedMessages, agent.clearSteeringQueue, agent.clearAllQueues, agent.steer, agent.followUp]
    .every((method) => typeof method === "function" && method.constructor.name !== "AsyncFunction")
    && (agent.steeringMode === "all" || agent.steeringMode === "one-at-a-time")
    && (agent.followUpMode === "all" || agent.followUpMode === "one-at-a-time");
}

export function mutableQueueAgent(agent: Partial<QueueAgent>): QueueAgent {
  if (!hasQueueApi(agent)) throw new Error("Runtime does not support synchronous queue message mutation");
  return agent;
}

/** SDK getters expose mutable backing arrays despite our read-only session contract. */
export function mutableTextMirror(texts: readonly string[]): string[] {
  if (!Array.isArray(texts) || !texts.every((text: unknown) => typeof text === "string") || typeof texts.splice !== "function"
    || !Object.isExtensible(texts) || Object.isSealed(texts) || Object.getOwnPropertyDescriptor(texts, "length")?.writable !== true
    || Object.keys(texts).some((key) => /^\d+$/.test(key) && Object.getOwnPropertyDescriptor(texts, key)?.writable !== true)) {
    throw new Error("SDK queue text mirrors are not mutable string arrays");
  }
  return texts;
}

export function queuedMessageAttachmentCount(message: AgentMessage): number {
  return message.role === "user" && Array.isArray(message.content) ? message.content.filter((part) => part.type === "image").length : 0;
}

function matchQueueEntries(messages: AgentMessage[], texts: readonly string[]): { text: string; message: AgentMessage | undefined }[] {
  let start = 0;
  return texts.map((text) => {
    const index = messages.findIndex((message, index) => index >= start && message.role === "user"
      && (typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("")) === text);
    const message = messages[index];
    if (index >= 0) start = index + 1;
    return { text, message };
  });
}

export function mirroredQueueEntries(messages: AgentMessage[], texts: readonly string[]): { text: string; message: AgentMessage }[] {
  return matchQueueEntries(messages, texts).map(({ text, message }) => {
    if (message === undefined) throw new Error("Runtime queue text mirrors are out of sync");
    return { text, message };
  });
}

/** Queue-update events can briefly precede the SDK's full-message enqueue. */
export function queuedMessageAttachmentCounts(messages: AgentMessage[], texts: readonly string[]): number[] {
  return matchQueueEntries(messages, texts).map(({ message }) => message === undefined ? 0 : queuedMessageAttachmentCount(message));
}
