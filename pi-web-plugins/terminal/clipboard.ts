export interface ClipboardTextWriteHost {
  readonly isSecureContext: boolean;
  readonly writeText?: (text: string) => Promise<void>;
  readonly fallbackWriteText: (text: string) => boolean;
}

export async function writeClipboardText(text: string, host: ClipboardTextWriteHost = browserClipboardTextWriteHost()): Promise<boolean> {
  if (!host.isSecureContext) return host.fallbackWriteText(text);

  if (host.writeText !== undefined) {
    try {
      await host.writeText(text);
      return true;
    } catch {
      return host.fallbackWriteText(text);
    }
  }

  return host.fallbackWriteText(text);
}

function browserClipboardTextWriteHost(): ClipboardTextWriteHost {
  const fallbackWriteText = (text: string) => writeClipboardTextWithSelectionFallback(text);
  const writeText = browserClipboardWriteText();
  return writeText === undefined
    ? { isSecureContext: browserIsSecureContext(), fallbackWriteText }
    : { isSecureContext: browserIsSecureContext(), writeText, fallbackWriteText };
}

function browserIsSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext;
}

function browserClipboardWriteText(): ((text: string) => Promise<void>) | undefined {
  if (typeof navigator === "undefined" || !("clipboard" in navigator)) return undefined;
  return navigator.clipboard.writeText.bind(navigator.clipboard);
}

function writeClipboardTextWithSelectionFallback(text: string): boolean {
  if (typeof document === "undefined") return false;

  const activeElement = document.activeElement;
  const selection = document.getSelection();
  const selectedRanges = selection === null ? [] : selectionRanges(selection);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Required for HTTP/private-network pages where navigator.clipboard is unavailable.
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    restoreSelection(selection, selectedRanges);
    restoreFocus(activeElement);
  }
}

function selectionRanges(selection: Selection): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    ranges.push(selection.getRangeAt(index));
  }
  return ranges;
}

function restoreSelection(selection: Selection | null, ranges: readonly Range[]): void {
  if (selection === null) return;
  try {
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
  } catch {
    // Restoring the prior selection is best-effort; the copy result should remain authoritative.
  }
}

function restoreFocus(element: Element | null): void {
  if (typeof HTMLElement === "undefined" || !(element instanceof HTMLElement)) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}
