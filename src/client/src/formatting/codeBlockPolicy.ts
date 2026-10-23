/** Source presentation is independent of whether plugins may inspect a block. */
export interface CodeBlockSourcePolicy {
  readonly presentation: "plain" | "code";
  readonly overflow: "wrap" | "scroll";
  readonly copy: boolean;
}

export interface CodeBlockPolicy extends CodeBlockSourcePolicy {
  readonly previews: boolean;
}

/** Preserve standalone FormattedText's existing capabilities. */
export const DEFAULT_CODE_BLOCK_POLICY: CodeBlockPolicy = Object.freeze({
  presentation: "code",
  overflow: "scroll",
  copy: true,
  previews: true,
});

/** The known-good chat baseline; enhancements can be restored independently. */
export const PLAIN_CODE_BLOCK_POLICY: CodeBlockPolicy = Object.freeze({
  presentation: "plain",
  overflow: "wrap",
  copy: false,
  previews: false,
});
