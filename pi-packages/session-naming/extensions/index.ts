import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSessionNamingConfig, sessionNamingAgentDir, type ResolvedSessionNamingConfig } from "../config.js";
import { fallbackSessionName, generateShortSessionName } from "../generator.js";

interface NamingDependencies {
  loadConfig: () => Promise<ResolvedSessionNamingConfig>;
  warn: (error: unknown) => void;
}

export default function sessionNaming(pi: ExtensionAPI): void {
  registerSessionNaming(pi, {
    loadConfig: () => loadSessionNamingConfig(sessionNamingAgentDir()),
    warn: (error) => { console.warn("[session-naming] Automatic naming failed; using the first request as a fallback:", error); },
  });
}

export function registerSessionNaming(pi: ExtensionAPI, dependencies: NamingDependencies): void {
  const attempted = new Set<string>();
  let generation = 0;
  let active: AbortController | undefined;
  const cancel = () => {
    generation++;
    active?.abort();
    active = undefined;
  };
  pi.on("session_shutdown", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_start", cancel);
  // A name set and subsequently cleared while the request is pending still wins.
  pi.on("session_info_changed", cancel);

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user") return;
    const id = ctx.sessionManager.getSessionId();
    if (attempted.has(id) || active || hasName(pi, ctx)
      || ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
    attempted.add(id);
    const model: Model<Api> | undefined = ctx.model;
    const requestSignal = ctx.signal;
    const token = ++generation;
    const controller = new AbortController();
    active = controller;
    const signal = requestSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, requestSignal]);
    const current = () => !signal.aborted && generation === token
      && ctx.sessionManager.getSessionId() === id && !hasName(pi, ctx);
    // Deliberately detached: before_agent_start must never await config or a provider.
    const nameSession = async () => {
      let name: string | undefined;
      try {
        const config = await dependencies.loadConfig();
        if (!current()) return;
        const selected = config.model === undefined ? model : (() => {
          const slash = config.model.indexOf("/");
          return ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
        })();
        if (!selected) throw new Error(`Session naming model unavailable: ${config.model ?? "session model"}`);
        name = await generateShortSessionName(ctx.modelRegistry, selected, event.prompt, config, signal);
        if (name === undefined) throw new Error("Session naming model returned an empty title");
      } catch (error) {
        if (!current()) return;
        dependencies.warn(error);
        name = fallbackSessionName(event.prompt);
      }
      if (current() && name !== undefined) pi.setSessionName(name);
    };
    void nameSession().catch(dependencies.warn).finally(() => {
      if (generation === token) active = undefined;
    });
  });
}

function hasName(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  return (pi.getSessionName() ?? "") !== "" || (ctx.sessionManager.getSessionName() ?? "") !== "";
}
