import type { PluginCapability, SyntaxHighlighterContribution, SyntaxHighlightingCapability, SyntaxHighlightRequest, SyntaxHighlightToken, SyntaxHighlightTokenKind } from "../../../plugin-api";
import { snapshotContentSelectors } from "../plugins/contentRenderers";

/** Bound parser work independently of a consumer's file-size allowance. */
export const MAX_SYNTAX_HIGHLIGHT_LENGTH = 100_000;

export const syntaxHighlightingCapabilityToken: PluginCapability<SyntaxHighlightingCapability> = {
  pluginId: "pi-web", id: "syntax-highlighting", version: 1,
  parse(value) {
    if (!isSyntaxHighlightingCapability(value)) {
      throw new Error("Syntax highlighting capability v1 is unavailable");
    }
    return value;
  },
};

function isSyntaxHighlightingCapability(value: unknown): value is SyntaxHighlightingCapability {
  return typeof value === "object" && value !== null && "highlight" in value && typeof value.highlight === "function"
    && "supports" in value && typeof value.supports === "function";
}

export interface RegisteredSyntaxHighlighter extends SyntaxHighlighterContribution {
  pluginId: string;
  localId: string;
  label: string;
  machineId?: string;
  sourcePluginId?: string;
}

const tokenKinds: ReadonlySet<string> = new Set<SyntaxHighlightTokenKind>([
  "keyword", "string", "number", "comment", "type", "function", "variable", "operator", "punctuation", "property", "literal", "meta",
]);

function isTokenKind(value: unknown): value is SyntaxHighlightTokenKind {
  return typeof value === "string" && tokenKinds.has(value);
}

/** Validate untrusted plugin results and detach them from plugin-owned mutable data. */
export function validateSyntaxHighlightTokens(value: unknown, text: string): readonly SyntaxHighlightToken[] {
  if (!Array.isArray(value)) throw new Error("Syntax highlighter must return an array of tokens");
  let end = 0;
  return Object.freeze(Array.from(value, (token: unknown) => {
    if (typeof token !== "object" || token === null || !("from" in token) || !("to" in token) || !("kind" in token)
      || typeof token.from !== "number" || typeof token.to !== "number"
      || !Number.isInteger(token.from) || !Number.isInteger(token.to)
      || token.from < end || token.to <= token.from || token.to > text.length
      || !isTokenKind(token.kind)) {
      throw new Error("Invalid syntax highlight token: expected sorted, nonoverlapping UTF-16 bounds and a standard kind");
    }
    end = token.to;
    return Object.freeze({ from: token.from, to: token.to, kind: token.kind });
  }));
}

export function snapshotSyntaxHighlighter(contribution: SyntaxHighlighterContribution): SyntaxHighlighterContribution {
  if (typeof contribution.highlight !== "function") throw new Error("Syntax highlighter must have a highlight callback");
  return Object.freeze({ id: contribution.id, ...snapshotContentSelectors(contribution), highlight: contribution.highlight.bind(contribution) });
}

/** Cancellation settles promptly even if plugin code ignores its signal. */
export async function runSyntaxHighlighter(highlighter: SyntaxHighlighterContribution, text: string, signal: AbortSignal): Promise<readonly SyntaxHighlightToken[]> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // AbortSignal deliberately permits non-Error reasons; preserve the caller's reason.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return highlighter.highlight({ text, signal });
    });
    const result = await Promise.race([work, cancelled]);
    signal.throwIfAborted();
    return validateSyntaxHighlightTokens(result, text);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(`Syntax highlighter ${highlighter.id} failed`, { cause: error });
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export function createSyntaxHighlightingCapability(select: (request: Pick<SyntaxHighlightRequest, "machineId" | "language" | "filePath">) => RegisteredSyntaxHighlighter | undefined): SyntaxHighlightingCapability {
  return Object.freeze({
    supports: (request: Pick<SyntaxHighlightRequest, "machineId" | "language" | "filePath">) => select(request) !== undefined,
    async highlight(request: SyntaxHighlightRequest) {
      request.signal.throwIfAborted();
      if (request.text.length > MAX_SYNTAX_HIGHLIGHT_LENGTH) return undefined;
      const highlighter = select(request);
      return highlighter?.highlight({ text: request.text, signal: request.signal });
    },
  });
}
