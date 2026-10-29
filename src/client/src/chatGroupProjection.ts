import { groupChatMessages, type ChatDisplayGroup, type ChatGroup, type ChatToolImageOutput } from "./chatGroups";
import type { ChatLine } from "./chatTypes";

type ActivityGroup = Extract<ChatGroup, { kind: "group" }>;
type ReadableGroup = Exclude<ChatGroup, ActivityGroup>;
interface MessageSlices {
  technical?: ChatLine;
  readable?: ReadableGroup;
}

/** Owned by one ChatView. Inputs and returned projections must be treated as immutable. */
export class ChatGroupProjection {
  private readonly slices = new WeakMap<ChatLine, MessageSlices>();
  private messages: readonly ChatLine[] = [];
  private offset = 0;
  private groups: ChatGroup[] = [];
  private displayGroups: ChatDisplayGroup[] | undefined;

  update(messages: readonly ChatLine[], indexOffset = 0): ChatGroup[] {
    if (messages === this.messages && indexOffset === this.offset) return this.groups;

    let restart = 0;
    if (indexOffset === this.offset) {
      while (restart < messages.length && restart < this.messages.length && messages[restart] === this.messages[restart]) restart++;
      if (restart === messages.length && restart === this.messages.length) {
        this.messages = messages;
        return this.groups;
      }
      // A readable slice flushes activity, so the next source is a safe restart.
      // Invisible markers do not close a group; mixed messages close it only after
      // their technical slice, which must not be included a second time.
      while (restart > 0) {
        const source = messages[restart - 1];
        if (source !== undefined && this.getSlices(source).readable !== undefined) break;
        restart--;
      }
    }

    const absoluteRestart = indexOffset + restart;
    const next: ChatGroup[] = [];
    const previous = new Map<string, ChatGroup>();
    for (const group of this.groups) {
      const end = group.kind === "group" ? group.endIndex : group.index;
      if (restart > 0 && end < absoluteRestart) next.push(group);
      else previous.set(groupKey(group), group);
    }

    const retain = (group: ChatGroup) => {
      const old = previous.get(groupKey(group));
      next.push(old !== undefined && sameGroup(old, group) ? old : group);
    };
    let events: ActivityGroup["messages"] = [];
    const flush = () => {
      const first = events[0];
      const last = events.at(-1);
      if (first === undefined || last === undefined) return;
      retain({ kind: "group", messages: events, startIndex: first.index, endIndex: last.index });
      events = [];
    };
    for (let index = restart; index < messages.length; index++) {
      const source = messages[index];
      if (source === undefined) continue;
      const slices = this.getSlices(source);
      const absoluteIndex = indexOffset + index;
      if (slices.technical !== undefined) events.push({ message: slices.technical, index: absoluteIndex });
      if (slices.readable !== undefined) {
        flush();
        retain({ ...slices.readable, index: absoluteIndex });
      }
    }
    flush();
    this.messages = messages;
    this.offset = indexOffset;
    if (next.length !== this.groups.length || next.some((group, index) => group !== this.groups[index])) {
      this.groups = next;
      if (this.displayGroups !== undefined) this.displayGroups = this.projectDisplayGroups();
    }
    return this.groups;
  }

  /** Call after update(); unchanged adjoining galleries keep their identity too. */
  getDisplayGroups(): ChatDisplayGroup[] {
    this.displayGroups ??= this.projectDisplayGroups();
    return this.displayGroups;
  }

  private projectDisplayGroups(): ChatDisplayGroup[] {
    const previous = new Map<ChatToolImageOutput, Extract<ChatDisplayGroup, { kind: "tool-images" }>>();
    for (const group of this.displayGroups ?? []) {
      if (group.kind === "tool-images") previous.set(group.outputs[0], group);
    }
    const next: ChatDisplayGroup[] = [];
    for (let index = 0; index < this.groups.length; index++) {
      const group = this.groups[index];
      if (group === undefined) continue;
      if (group.kind !== "tool-image") {
        next.push(group);
        continue;
      }
      const outputs: [ChatToolImageOutput, ...ChatToolImageOutput[]] = [group];
      let following = this.groups[index + 1];
      while (following?.kind === "tool-image") {
        outputs.push(following);
        index++;
        following = this.groups[index + 1];
      }
      const old = previous.get(group);
      next.push(old?.outputs.length === outputs.length && outputs.every((output, i) => output === old.outputs[i])
        ? old : { kind: "tool-images", outputs });
    }
    return next;
  }

  private getSlices(message: ChatLine): MessageSlices {
    const cached = this.slices.get(message);
    if (cached !== undefined) return cached;
    // Keep the existing grouping function as the authority on visibility, roles,
    // metadata and tool-image attribution. Each immutable source is split once.
    const slices: MessageSlices = {};
    for (const group of groupChatMessages([message])) {
      if (group.kind === "group") {
        const technical = group.messages[0]?.message;
        if (technical !== undefined) slices.technical = technical;
      }
      else slices.readable = group;
    }
    this.slices.set(message, slices);
    return slices;
  }
}

function groupKey(group: ChatGroup): string {
  return `${group.kind}:${String(group.kind === "group" ? group.startIndex : group.index)}`;
}

function sameGroup(left: ChatGroup, right: ChatGroup): boolean {
  if (left.kind === "group" && right.kind === "group") {
    return left.startIndex === right.startIndex && left.endIndex === right.endIndex
      && left.messages.length === right.messages.length
      && left.messages.every((event, index) => {
        const other = right.messages[index];
        return event.index === other?.index && event.message === other.message;
      });
  }
  return left.kind !== "group" && right.kind !== "group" && left.kind === right.kind
    && left.index === right.index && left.message === right.message;
}
