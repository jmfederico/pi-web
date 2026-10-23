import { DEFAULT_CHAT_BEHAVIORS, type ChatBehaviors } from "./chatBehaviors";

/** Isolate automatic effects without disabling content or explicit user actions. */
export const MANUAL_CHAT_BEHAVIORS: ChatBehaviors = Object.freeze({
  ...DEFAULT_CHAT_BEHAVIORS,
  rememberPosition: false,
  followTail: false,
  automaticHistory: false,
  anchorPrepends: false,
  rememberDisclosures: false,
});
