import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_FINDINGS, REVIEW_REPLY, REVIEW_REQUEST, reviewPrompt } from "./browser/protocol.js";

export default function companion(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let active: { requestId: string; prompt: string; started: boolean; text: string; stopReason: string; error?: string } | undefined;
  const reply = (requestId: string, result: object) => { pi.events.emit(REVIEW_REPLY, { requestId, ...result }); };
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => {
    if (active) reply(active.requestId, { status: "failed", error: "Review interrupted by session shutdown or reload" });
    active = undefined;
    context = undefined;
  });
  pi.on("before_agent_start", (event) => {
    if (!active) return;
    if (!active.started && event.prompt === active.prompt) active.started = true;
    else active.error = "Another prompt interfered with this review; findings were not saved";
  });
  pi.on("message_start", (event) => {
    if (!active || event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (text !== active.prompt) active.error = "Another user message interfered with this review";
  });
  pi.on("tool_result", (event) => {
    if (active?.started === true && event.isError) active.error = `Review tool failed: ${event.toolName}. Inspect the conversation and retry explicitly.`;
  });
  pi.on("message_end", (event) => {
    if (active?.started !== true || event.message.role !== "assistant") return;
    active.text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    active.stopReason = event.message.stopReason;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      active.error = event.message.errorMessage ?? `Review ${event.message.stopReason}`;
    }
  });
  // agent_end can precede automatic retries/compaction. Settlement is the final boundary.
  pi.on("agent_settled", () => {
    if (active?.started !== true) return;
    const result = active;
    active = undefined;
    const error = result.error ?? (result.stopReason !== "stop" || !result.text.trim()
      ? "Review ended without a successful final text response" : result.text.length > MAX_FINDINGS
        ? "Review findings exceeded the storage limit" : undefined);
    reply(result.requestId, error !== undefined ? { status: "failed", error } : { status: "completed", text: result.text });
  });
  // Pi owns listeners and replaces them on /reload. No background resources at load time.
  pi.events.on(REVIEW_REQUEST, (data) => {
    if (typeof data !== "object" || data === null || !("requestId" in data)
      || typeof data.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(data.requestId)) return;
    const { requestId } = data;
    if (!context || active || !context.isIdle() || context.hasPendingMessages()) {
      reply(requestId, { status: "failed", error: "Companion not ready or session busy; use a new review session" });
      return;
    }
    const prompt = reviewPrompt(requestId);
    active = { requestId, prompt, started: false, text: "", stopReason: "" };
    try {
      pi.sendUserMessage(prompt);
      reply(requestId, { status: "accepted" });
    } catch (error) {
      active = undefined;
      reply(requestId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
