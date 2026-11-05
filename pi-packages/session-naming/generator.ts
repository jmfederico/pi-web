import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedSessionNamingConfig } from "./config.js";

/** Runs through the session registry so provider resolution and authentication stay Pi-owned. */
export async function generateShortSessionName(
  registry: Pick<ExtensionContext["modelRegistry"], "streamSimple">,
  model: Model<Api>,
  firstMessage: string,
  config: ResolvedSessionNamingConfig,
  signal: AbortSignal,
): Promise<string | undefined> {
  const controller = new AbortController();
  const cancel = () => { controller.abort(signal.reason); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => { controller.abort(new Error("Session naming timed out")); }, config.timeoutMs);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => {
      const reason: unknown = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error("Session naming cancelled"));
    };
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    // Race the stream as well as sending its signal: a provider that ignores abort
    // must not leave naming pending forever or write a late title after timeout.
    return await Promise.race([aborted, (async () => {
      controller.signal.throwIfAborted();
      const stream = registry.streamSimple(model, {
        systemPrompt: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.",
        messages: [{
          role: "user",
          content: `Create a 2-6 word title for this request:\n\n${firstMessage.length <= 4_000 ? firstMessage : `${firstMessage.slice(0, 4_000)}…`}`,
          timestamp: Date.now(),
        }],
      }, {
        maxTokens: config.maxTokens,
        ...(config.thinkingLevel === "off" ? {} : { reasoning: config.thinkingLevel }),
        signal: controller.signal,
      });
      let streamedText = "";
      let finalMessage: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === "text_delta") streamedText += event.delta;
        if (event.type === "done") finalMessage = event.message;
        if (event.type === "error") throw new Error(event.error.errorMessage ?? "Session naming provider failed");
      }
      return cleanSessionName(finalMessage === undefined ? streamedText : finalMessage.content
        .filter((part) => part.type === "text").map((part) => part.text).join(""));
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}

export function fallbackSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;
  return cleanSessionName(firstMessage
    .replace(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#[\](){}<>]/g, " ")
    .split(/\s+/).filter(Boolean).slice(0, 6).join(" "));
}

export function cleanSessionName(value: string): string | undefined {
  const title = (value.split("\n", 1)[0] ?? "")
    .replace(/^\s*(title|session title)\s*:\s*/i, "")
    .replace(/^\s*["'`]+|["'`.]+\s*$/g, "")
    // Provider output and fallback names must remain safe session metadata.
    // eslint-disable-next-line no-control-regex -- remove unsafe metadata characters.
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return title === "" ? undefined : title;
}
