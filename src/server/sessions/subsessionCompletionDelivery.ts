import type { CustomMessageEntryDraft, ExtensionFactory } from "../../piSdk.js";

export interface SubsessionCompletionDeliveryDeps {
  prepare(parentSessionId: string, parentSessionFile?: string): Promise<CustomMessageEntryDraft | undefined>;
}

/** Use Pi's final actionable boundary, not a second queue of already-rendered answers. */
export function createSubsessionCompletionDelivery(deps: SubsessionCompletionDeliveryDeps): ExtensionFactory {
  return (pi) => {
    pi.on("agent_before_settle", async (event, ctx) => {
      // A manual stop or failed parent run must not be resumed by this hook.
      if (event.outcome !== "completed") return;
      const message = await deps.prepare(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
      if (message === undefined) return;
      return { entries: [...event.entries, message], continue: true };
    });
  };
}
