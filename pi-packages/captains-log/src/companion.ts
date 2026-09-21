import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_FINDINGS, UUID, CAPTAIN_REPLY, CAPTAIN_REQUEST, SOURCE_REQUEST, SOURCE_REPLY, PIRATE_INTRO, PIRATE_MARKER, captainPrompt } from "./browser/protocol.js";

export default function companion(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let active: { requestId: string; prompt: string; nextPrompt?: string; started: boolean; text: string; stopReason: string; error?: string } | undefined;
  const reply = (requestId: string, result: object) => { pi.events.emit(CAPTAIN_REPLY, { requestId, ...result }); };
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => {
    if (active) reply(active.requestId, { status: "failed", error: "Captain request interrupted by session shutdown or reload" });
    active = undefined;
    context = undefined;
  });
  pi.on("before_agent_start", (event) => {
    if (!active) return;
    if (!active.started && event.prompt === active.prompt) {
      active.started = true;
      if (event.prompt === PIRATE_INTRO) pi.appendEntry(PIRATE_MARKER, {});
      reply(active.requestId, { status: "running" });
    }
    else active.error = "Another prompt interfered with this Captain request; translation was not saved";
  });
  pi.on("message_start", (event) => {
    if (!active || event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (text !== active.prompt) active.error = "Another user message interfered with this Captain request";
  });
  pi.on("tool_result", (event) => {
    if (active?.started === true && event.isError) active.error = `Captain tool failed: ${event.toolName}. Inspect the conversation and retry explicitly.`;
  });
  pi.on("message_end", (event) => {
    if (active?.started !== true || event.message.role !== "assistant") return;
    active.text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    active.stopReason = event.message.stopReason;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      active.error = event.message.errorMessage ?? `Captain request ${event.message.stopReason}`;
    }
  });
  // agent_end can precede automatic retries/compaction. Settlement is the final boundary.
  pi.on("agent_settled", () => {
    if (active?.started !== true) return;
    const result = active;
    active = undefined;
    const error = result.error ?? (result.stopReason !== "stop" || !result.text.trim()
      ? "Captain request ended without a successful final text response" : result.text.length > MAX_FINDINGS
        ? "Captain reply exceeded the storage limit" : undefined);
    if (error === undefined && result.nextPrompt !== undefined) {
      active = { requestId: result.requestId, prompt: result.nextPrompt, started: false, text: "", stopReason: "" };
      try { pi.sendUserMessage(active.prompt); }
      catch (failure) { active = undefined; reply(result.requestId, { status: "failed", error: String(failure) }); }
      return;
    }
    reply(result.requestId, error !== undefined ? { status: "failed", error } : { status: "completed", text: result.text });
  });
  // Read only this companion's active branch; never prompt, rename, or append to the source.
  pi.events.on(SOURCE_REQUEST, (data) => {
    if (typeof data !== "object" || data === null || !("requestId" in data)
      || typeof data.requestId !== "string" || !UUID.test(data.requestId)) return;
    const respond = (result: object) => { pi.events.emit(SOURCE_REPLY, { requestId: data.requestId, ...result }); };
    try {
      if (!context || active || !context.isIdle() || context.hasPendingMessages()) throw new Error("Source session must be idle with no pending messages. Wait for it to finish, then translate again.");
      if (context.sessionManager.getEntries().some((entry) => entry.type === "custom" && (entry.customType === PIRATE_MARKER || entry.customType === "captains-log:request"))) throw new Error("Select a source session other than the pirate conversation.");
      for (const entry of [...context.sessionManager.getBranch()].reverse()) {
        if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "stop") continue;
        const text = entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (!text.trim()) continue;
        if (text.length > MAX_FINDINGS) throw new Error("Source reply exceeds the translation limit (48000 characters).");
        respond({ status: "completed", text });
        return;
      }
      throw new Error("Source session has no completed assistant text reply on its active branch.");
    } catch (error) { respond({ status: "failed", error: error instanceof Error ? error.message : String(error) }); }
  });
  // Pi owns listeners and replaces them on /reload. No background resources at load time.
  pi.events.on(CAPTAIN_REQUEST, (data) => {
    if (typeof data !== "object" || data === null || !("requestId" in data)
      || typeof data.requestId !== "string" || !UUID.test(data.requestId)) return;
    if (!("text" in data) || typeof data.text !== "string" || !data.text.trim() || data.text.length > MAX_FINDINGS) {
      reply(data.requestId, { status: "failed", error: "Invalid translation text" });
      return;
    }
    const { requestId } = data;
    if (!context || active || !context.isIdle() || context.hasPendingMessages()) {
      reply(requestId, { status: "failed", error: "Companion not ready or session busy; open Captain's Log in Sessions, wait for idle, then retry" });
      return;
    }
    const introduced = context.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === PIRATE_MARKER);
    const translation = captainPrompt(data.text);
    const prompt = introduced ? translation : PIRATE_INTRO;
    active = { requestId, prompt, ...(introduced ? {} : { nextPrompt: translation }), started: false, text: "", stopReason: "" };
    try {
      pi.setSessionName("Captain's Log");
      pi.appendEntry("captains-log:request", { requestId });
      reply(requestId, { status: "accepted" });
      pi.sendUserMessage(prompt);
    } catch (error) {
      active = undefined;
      reply(requestId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
