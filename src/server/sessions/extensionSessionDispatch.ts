import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isKnownThinkingLevel } from "../../shared/thinkingLevels.js";
import { requireSessionUiMetadata } from "./sessionMetadata.js";
import { requireInitialSessionName } from "./sessionNameGenerator.js";
import type { SpawnSessionInvocation, SpawnSessionToolDeps } from "./spawnSessionTool.js";

/** In-process extension protocol. The synchronous receipt avoids timeout/retry ambiguity. */
export const SESSION_DISPATCH_CHANNEL = "pi-web:session-dispatch:v1";

interface DispatchDependencies {
  spawn?: SpawnSessionToolDeps["spawn"];
  isEnabled(): boolean;
}

/** Pi owns these registrations and replaces them on reload; no global bus or resources. */
export function createExtensionSessionDispatch(cwd: string, deps: DispatchDependencies): ExtensionFactory {
  return (pi) => {
    let context: ExtensionContext | undefined;
    pi.on("session_start", (_event, ctx) => { context = ctx; });
    pi.on("session_shutdown", () => { context = undefined; });
    pi.events.on(SESSION_DISPATCH_CHANNEL, (request) => {
      if (!isRecord(request)) return;
      const accept = request["accept"];
      if (typeof accept !== "function") return;
      // Receipt is synchronous, while validation/spawn failures travel in the
      // accepted promise rather than disappearing into Pi's fire-and-forget bus.
      const result = (async () => {
        if (context === undefined) throw new Error("Session dispatch requires an active Pi session");
        if (!deps.isEnabled() || deps.spawn === undefined) throw new Error("Session dispatch is disabled for this session");
        const invocation = parseInvocation(request["input"], cwd, context);
        return deps.spawn(invocation);
      })();
      Reflect.apply(accept, undefined, [result]);
    });
  };
}

function parseInvocation(value: unknown, cwd: string, ctx: ExtensionContext): SpawnSessionInvocation {
  if (!isRecord(value)) throw new Error("Session dispatch input must be an object");
  const allowed = new Set(["prompt", "cwd", "name", "metadata", "model", "thinkingLevel"]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new Error(`Unsupported session dispatch field: ${String(key)}`);
  }
  const prompt = requiredString(value["prompt"], "prompt", 64 * 1024);
  if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) throw new Error("Session dispatch prompt exceeds 65536 UTF-8 bytes");
  const targetCwd = optionalString(value["cwd"], "cwd", 4096);
  const name = value["name"] === undefined ? undefined : requireInitialSessionName(value["name"]);
  const modelSpec = optionalString(value["model"], "model", 512);
  const thinkingLevel = value["thinkingLevel"];
  if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !isKnownThinkingLevel(thinkingLevel))) {
    throw new Error("Unknown session dispatch thinking level");
  }
  const metadata = value["metadata"] === undefined ? undefined : requireSessionUiMetadata(value["metadata"]);
  const thinking = thinkingLevel ?? ctx.thinkingLevel;
  return {
    spawningCwd: cwd,
    spawningSessionId: ctx.sessionManager.getSessionId(),
    prompt,
    cwd: targetCwd,
    ...(name === undefined ? {} : { name }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
    ...(modelSpec === undefined ? {} : { modelSpec }),
    ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
  };
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new Error(`Session dispatch ${label} must be non-empty and at most ${String(maxLength)} characters`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, label, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
