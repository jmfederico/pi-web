import type { BoundaryState, CustomMessageEntryDraft, ExtensionContext, ExtensionFactory } from "../../piSdk.js";

export interface SubsessionCompletionDeliveryDeps {
  prepare(parentSessionId: string, parentSessionFile?: string): Promise<CustomMessageEntryDraft | undefined>;
}

/** Deliver at safe turn boundaries without a second queue of rendered notices. */
export function createSubsessionCompletionDelivery(deps: SubsessionCompletionDeliveryDeps): ExtensionFactory {
  return (pi) => {
    const deliver = async (event: BoundaryState, ctx: ExtensionContext) => {
      // A manual stop or failed parent run must not be resumed by this hook.
      if (event.outcome !== "completed") return;
      const message = await deps.prepare(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
      if (message === undefined) return;
      return { entries: [...event.entries, message], continue: true };
    };
    pi.on("turn_end", deliver);
    // Catch children that finish after the last turn boundary, including yield.
    pi.on("agent_before_settle", deliver);
  };
}
