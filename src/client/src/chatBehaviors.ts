import { PLAIN_CODE_BLOCK_POLICY, type CodeBlockPolicy } from "./formatting/codeBlockPolicy";

/** Independent chat capabilities; overrides are injected, not read from ambient storage. */
export interface ChatBehaviors {
  readonly rememberPosition: boolean;
  readonly followTail: boolean;
  readonly automaticHistory: boolean;
  readonly anchorPrepends: boolean;
  readonly loadImages: boolean;
  readonly codeBlocks: CodeBlockPolicy;
  readonly rememberDisclosures: boolean;
  readonly visualEffects: boolean;
  /** Windowing pilot; remains disabled until browser/interaction acceptance is complete. */
  readonly mountingWindow: boolean;
}

export const DEFAULT_CHAT_BEHAVIORS: ChatBehaviors = Object.freeze({
  rememberPosition: true,
  followTail: true,
  automaticHistory: true,
  anchorPrepends: true,
  loadImages: true,
  codeBlocks: Object.freeze({ ...PLAIN_CODE_BLOCK_POLICY, presentation: "code", overflow: "scroll", copy: true, previews: true }),
  rememberDisclosures: true,
  visualEffects: true,
  mountingWindow: false,
});
