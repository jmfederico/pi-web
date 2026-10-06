import type { DisplayedMessageActionAvailabilityContext, DisplayedMessageActionMessage, MessageActionAvailabilityContext, MessageActionContribution, MessageActionMessage } from "../../../plugin-api";
import type { ChatLine } from "../components/shared";
import type { WorkspacePluginBinding } from "./types";

export type RegisteredMessageAction = MessageActionContribution & {
  readonly binding: WorkspacePluginBinding;
  readonly machineId?: string;
};

export interface AvailableMessageAction {
  readonly action: RegisteredMessageAction;
  readonly enabled: boolean;
  readonly ariaLabel: string;
}

export function messageActionMessage(message: ChatLine, role = message.role): MessageActionMessage | undefined {
  if (message.entryId === undefined) return undefined;
  return Object.freeze({
    entryId: message.entryId,
    role,
    text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n"),
  });
}

export function displayedMessageActionMessage(message: ChatLine): DisplayedMessageActionMessage {
  return Object.freeze({
    ...(message.entryId === undefined ? {} : { entryId: message.entryId }),
    role: message.role,
    text: message.parts.filter((part) => part.type === "text").map((part) => part.text.trim()).filter(Boolean).join("\n\n"),
  });
}

export function availableMessageActions(
  actions: readonly RegisteredMessageAction[],
  context: MessageActionAvailabilityContext,
): readonly AvailableMessageAction[] {
  return actions.filter((action) => action.target !== "display").filter((action) => action.visible?.(context) ?? true)
    .map((action) => ({ action, enabled: action.enabled?.(context) ?? true, ariaLabel: action.ariaLabel?.(context) ?? action.title }));
}

export function availableDisplayedMessageActions(
  actions: readonly RegisteredMessageAction[],
  context: DisplayedMessageActionAvailabilityContext,
): readonly AvailableMessageAction[] {
  return actions.filter((action) => action.target === "display").filter((action) => action.visible?.(context) ?? true)
    .map((action) => ({ action, enabled: action.enabled?.(context) ?? true, ariaLabel: action.ariaLabel?.(context) ?? action.title }));
}

/** Transcript projections keep unchanged ChatLine identities across stream updates. */
export class MessageActionAvailabilityCache {
  private inputs = "";
  private actions: readonly RegisteredMessageAction[] = [];
  private messages = new WeakMap<ChatLine, Map<string, readonly AvailableMessageAction[]>>();

  get(
    message: ChatLine,
    actions: readonly RegisteredMessageAction[],
    context: Omit<MessageActionAvailabilityContext, "message">,
    displayed: ChatLine = message,
    includeEntryActions = true,
  ): readonly AvailableMessageAction[] {
    const inputs = JSON.stringify([context.machine, context.session]);
    if (inputs !== this.inputs || actions.length !== this.actions.length || actions.some((action, index) => action !== this.actions[index])) {
      this.inputs = inputs;
      this.actions = actions;
      this.messages = new WeakMap();
    }
    // One source can have several headers with the same role (thinking/text).
    // Include canonical status: another slice can take ownership of entry actions
    // without changing this source or displayed snapshot during a stream update.
    const snapshot = displayedMessageActionMessage(displayed);
    const key = JSON.stringify([snapshot.role, snapshot.text, includeEntryActions]);
    const slices = this.messages.get(message) ?? new Map<string, readonly AvailableMessageAction[]>();
    const cached = slices.get(key);
    if (cached !== undefined) return cached;
    const entry = includeEntryActions ? messageActionMessage(message, displayed.role) : undefined;
    const result = actions.flatMap((action) => action.target === "display"
      ? availableDisplayedMessageActions([action], { ...context, message: snapshot })
      : entry === undefined ? [] : availableMessageActions([action], { ...context, message: entry }));
    slices.set(key, result);
    this.messages.set(message, slices);
    return result;
  }
}
