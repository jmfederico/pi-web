import type { DisplayedMessageActionAvailabilityContext, MessageActionAvailabilityContext, MessageActionFeedback, MessageActionResult } from "../../../plugin-api";
import { displayedMessageActionMessage, messageActionMessage, MessageActionAvailabilityCache, type RegisteredMessageAction } from "../plugins/messageActions";
import type { ChatLine } from "../chatTypes";

export interface ChatMessageActionContext {
  machineId: string;
  sessionId: string;
  connected: boolean;
  actions: readonly RegisteredMessageAction[];
  availability?: Omit<MessageActionAvailabilityContext, "message"> | undefined;
  onEntry?: ((input: MessageActionAvailabilityContext, actionId: string) => Promise<MessageActionResult>) | undefined;
  onDisplay?: ((input: DisplayedMessageActionAvailabilityContext, actionId: string) => Promise<MessageActionResult>) | undefined;
}

interface ActionLocation { machineId: string; sessionId: string; generation: number; key: string }

/** Owns invocation concurrency and transient presentation, independently of Lit templates. */
export class ChatMessageActionController {
  private readonly availability = new MessageActionAvailabilityCache();
  private entryPending = false;
  private readonly displayPending = new Set<string>();
  private generation = 0;
  private error: (ActionLocation & { message: string }) | undefined;
  private feedback: (ActionLocation & { actionId: string; presentation: MessageActionFeedback }) | undefined;
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: () => ChatMessageActionContext, private readonly changed: () => void) {}

  available(source: ChatLine, displayed: ChatLine, includeEntryActions: boolean) {
    const context = this.context();
    return context.availability === undefined ? [] : this.availability.get(source, context.actions, context.availability, displayed, includeEntryActions)
      .filter(({ action }) => action.target === "display" ? context.onDisplay !== undefined : context.onEntry !== undefined);
  }

  pending(key: string, action: RegisteredMessageAction): boolean {
    return action.target === "display" ? this.displayPending.has(this.pendingKey(key, action.id)) : this.entryPending;
  }

  presentation(key: string, actionId: string): MessageActionFeedback | undefined {
    return this.feedback !== undefined && this.current(this.feedback) && this.feedback.key === key && this.feedback.actionId === actionId ? this.feedback.presentation : undefined;
  }

  errorMessage(key: string): string | undefined {
    return this.error !== undefined && this.current(this.error) && this.error.key === key ? this.error.message : undefined;
  }

  /** Retire feedback on session changes and disconnect, without unlocking an in-flight entry action. */
  reset(): void {
    this.generation += 1;
    this.clearFeedback();
    this.error = undefined;
    this.changed();
  }

  private location(key: string): ActionLocation {
    const { machineId, sessionId } = this.context();
    return { machineId, sessionId, generation: this.generation, key };
  }

  private pendingKey(key: string, actionId: string): string {
    const location = this.location(key);
    return JSON.stringify([location.machineId, location.sessionId, location.generation, key, actionId]);
  }

  private current(location: ActionLocation): boolean {
    const context = this.context();
    return context.connected && location.generation === this.generation && location.machineId === context.machineId && location.sessionId === context.sessionId;
  }

  async run(source: ChatLine, displayed: ChatLine, key: string, action: RegisteredMessageAction): Promise<void> {
    const context = this.context();
    if (context.availability === undefined || this.pending(key, action)) return;
    const entry = messageActionMessage(source, displayed.role);
    const { onEntry, onDisplay, availability } = context;
    const run = action.target === "display"
      ? onDisplay === undefined ? undefined : () => onDisplay({ ...availability, message: displayedMessageActionMessage(displayed) }, action.id)
      : entry === undefined || onEntry === undefined ? undefined : () => onEntry({ ...availability, message: entry }, action.id);
    if (run === undefined) return;
    const location = this.location(key);
    const pendingKey = this.pendingKey(key, action.id);
    if (action.target === "display") this.displayPending.add(pendingKey);
    else this.entryPending = true;
    this.error = undefined;
    this.changed();
    try {
      const presentation = await run();
      if (presentation !== undefined && this.current(location)) {
        this.clearFeedback();
        this.feedback = { ...location, actionId: action.id, presentation };
        this.feedbackTimer = setTimeout(() => { this.clearFeedback(); this.changed(); }, 1200);
      }
    } catch (error) {
      if (this.current(location)) this.error = { ...location, message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (action.target === "display") this.displayPending.delete(pendingKey);
      else this.entryPending = false;
      this.changed();
    }
  }

  private clearFeedback(): void {
    if (this.feedbackTimer !== undefined) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
    this.feedback = undefined;
  }
}
