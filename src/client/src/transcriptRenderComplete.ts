import { LitElement } from "lit";

/** Join the mounted Lit render tree before committing viewport geometry.
 * updateComplete waits for rendering, not image/network/preview enhancement;
 * those remain separate layout notifications. Descendants are discovered after
 * their parents render, rather than waiting an arbitrary number of frames.
 */
export async function transcriptRenderComplete(root: ParentNode): Promise<void> {
  const elements = Array.from(root.querySelectorAll("*")).filter((element): element is LitElement => element instanceof LitElement && element.isConnected);
  await Promise.all(elements.map(async (element) => {
    do { await element.updateComplete; } while (element.isConnected && element.isUpdatePending);
    if (element.isConnected && element.shadowRoot !== null) await transcriptRenderComplete(element.shadowRoot);
  }));
}
