// @vitest-environment happy-dom
import type { SyntaxHighlightToken } from "@jmfederico/pi-web/plugin-api";
import { afterEach, expect, it, vi } from "vitest";
import { TokenHighlightedCode } from "./TokenHighlightedCode";

customElements.define("test-token-highlighted-code", TokenHighlightedCode);
afterEach(() => { document.body.replaceChildren(); });

it("cancels obsolete grammar work and ignores results after source replacement or disconnect", async () => {
  const viewer = new TokenHighlightedCode();
  const pending: { signal: AbortSignal; resolve: (tokens: readonly SyntaxHighlightToken[]) => void }[] = [];
  viewer.highlight = (_text, signal) => new Promise((resolve) => { pending.push({ signal, resolve }); });
  const fail = vi.fn();
  viewer.input = { text: "old", signal: new AbortController().signal, fail };
  document.body.append(viewer);
  await vi.waitFor(() => { expect(pending).toHaveLength(1); });
  viewer.input = { ...viewer.input, text: "new" };
  await vi.waitFor(() => { expect(pending).toHaveLength(2); });
  expect(pending[0]?.signal.aborted).toBe(true);
  pending[1]?.resolve([{ from: 0, to: 3, kind: "string" }]);
  await vi.waitFor(() => { expect(viewer.renderRoot.querySelector(".hljs-string")?.textContent).toBe("new"); });
  pending[0]?.resolve([{ from: 0, to: 3, kind: "keyword" }]);
  await viewer.updateComplete;
  expect(viewer.renderRoot.querySelector(".hljs-keyword")).toBeNull();
  viewer.remove();
  expect(pending[1]?.signal.aborted).toBe(true);
  expect(fail).not.toHaveBeenCalled();
});

it.each(["failed", "unavailable"])("reports a %s grammar through the renderer failure boundary", async (reason) => {
  const failure = new Error("parser failed");
  const viewer = new TokenHighlightedCode();
  const fail = vi.fn();
  viewer.input = { text: "readable source", signal: new AbortController().signal, fail };
  viewer.highlight = () => reason === "failed" ? Promise.reject(failure) : Promise.resolve(undefined);
  document.body.append(viewer);
  await vi.waitFor(() => { expect(fail).toHaveBeenCalledOnce(); });
  expect(fail).toHaveBeenCalledWith(reason === "failed" ? failure : expect.objectContaining({ message: "Syntax highlighter is no longer available" }));
  expect(viewer.renderRoot.querySelector("code")?.textContent).toBe("readable source");
});
