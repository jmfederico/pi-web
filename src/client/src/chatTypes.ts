import type { ArgumentSummaryPresentation, ChatTextPresentation } from "./chatPresentation";
import type { AskUserOutcome, AskUserRequest } from "../../shared/apiTypes";
import type { ImageDimensions, SessionMediaReference } from "../../shared/sessionMedia";

export interface ToolPreview {
  diff?: string;
  firstChangedLine?: number;
  error?: string;
}

export interface ToolExecutionPart {
  type: "toolExecution";
  toolCallId?: string;
  toolName: string;
  summary: string;
  summaryPresentation?: ArgumentSummaryPresentation;
  args?: unknown;
  status: "pending" | "running" | "success" | "error";
  resultText?: string;
  content?: unknown;
  details?: unknown;
  preview?: ToolPreview;
}

/** A reference never carries base64; inline images remain compatible with older machines. */
export type ChatImagePart =
  | ({ type: "image"; mimeType: string; data: string; mediaId?: never; byteSize?: never } & Partial<ImageDimensions>)
  | (SessionMediaReference & { data?: never });

export interface CustomMessagePart {
  type: "customMessage";
  customType: string;
  content: unknown;
  details?: unknown;
  /** Original normalized presentation, without nested custom messages. */
  parts: ChatFallbackPart[];
}

export type ChatPart = ChatFallbackPart | CustomMessagePart;

export type ChatFallbackPart =
  | { type: "text"; text: string; displayText?: string; presentation?: ChatTextPresentation }
  | ChatImagePart
  | { type: "thinking"; text: string; displayText?: string }
  | { type: "skillInvocation"; name: string; location: string; content: string }
  | { type: "skillRead"; name: string; path: string; toolCallId?: string }
  | { type: "askUserQuestion"; ask: AskUserRequest }
  | { type: "askUserRecord"; outcome: AskUserOutcome }
  /** Retain a coalesced result's conversation position without repeating its UI. */
  | { type: "toolResultBoundary"; toolCallId?: string }
  | { type: "toolCall"; toolCallId?: string; toolName: string; summary: string; summaryPresentation?: ArgumentSummaryPresentation; args?: unknown }
  | ToolExecutionPart
  | { type: "toolResult"; toolCallId?: string; toolName: string; text: string; isError: boolean; content?: unknown; details?: unknown }
  | { type: "empty" };

/** The host presentation and conversation facts, independent of renderer choice. */
export function chatFallbackParts(parts: readonly ChatPart[]): ChatFallbackPart[] {
  return parts.flatMap((part): ChatFallbackPart[] => part.type === "customMessage" ? part.parts : [part]);
}

export interface ChatLine {
  /** Identity of one live assistant message, retained through finalization. */
  streamId?: string;
  /** Durable session-tree entry; absent for optimistic or in-flight messages. */
  entryId?: string;
  role: "user" | "assistant" | "tool" | "system" | "bash" | "skill";
  parts: ChatPart[];
  source?: "compaction" | "branch_summary";
  meta?: {
    timestamp?: string;
    model?: { provider?: string; id?: string; responseId?: string };
    /** Thinking level the assistant message was generated with, when known. */
    thinkingLevel?: string;
  };
}
