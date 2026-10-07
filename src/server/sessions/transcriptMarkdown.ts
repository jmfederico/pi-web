import type { MarkdownTransformer, MarkdownTransformContext } from "@earendil-works/pi-coding-agent";

/** Browser-only projection: never replace canonical content or pass this result back to Pi. */
export function projectTranscriptMarkdown<T>(
  message: T,
  transformers: readonly MarkdownTransformer[],
  onError: (error: unknown, transformerIndex: number) => void,
): T {
  return projectUnknownTranscriptMarkdown(message, transformers, onError) as T;
}

function projectUnknownTranscriptMarkdown(
  message: unknown,
  transformers: readonly MarkdownTransformer[],
  onError: (error: unknown, transformerIndex: number) => void,
): unknown {
  if (!isRecord(message) || transformers.length === 0) return message;
  const role = message["role"];
  if (role !== "user" && role !== "assistant") return message;

  const transform = (text: string, messageType: MarkdownTransformContext["messageType"]): string => {
    let result = text;
    for (const [index, transformer] of transformers.entries()) {
      try {
        // No terminal geometry exists in the browser. Use a fixed, positive width.
        const next = transformer(result, { messageType, isStreaming: false, availableWidth: 80 });
        if (typeof next !== "string") throw new TypeError("Markdown transformer must return a string");
        result = next;
      } catch (error) {
        onError(error, index);
      }
    }
    return result;
  };

  const content = message["content"];
  if (typeof content === "string") {
    const displayText = transform(content, role);
    return displayText === content ? message : { ...message, displayText };
  }
  if (!Array.isArray(content)) return message;
  const projected = content.map((part: unknown) => {
    if (!isRecord(part)) return part;
    const type = part["type"];
    const text = type === "text" ? part["text"] : type === "thinking" && role === "assistant" ? part["thinking"] ?? part["text"] : undefined;
    if (typeof text !== "string") return part;
    const displayText = transform(text, type === "thinking" ? "assistant-thinking" : role);
    if (displayText === text) return part;
    return { ...part, displayText };
  });
  return projected.some((part, index) => part !== content[index]) ? { ...message, content: projected } : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
