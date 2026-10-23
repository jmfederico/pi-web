import { activeModalElement, composedContains, isHiddenOrInertInComposedTree, observeModalRoot, subscribeModalChanges } from "./modalLayerRegistry";

interface Popup {
  owner: HTMLElement;
  close: () => void;
}

interface PopupScope {
  popups: Set<Popup>;
  dispose: () => void;
}

const scopes = new WeakMap<Document, PopupScope>();

/** Global shortcuts must defer Escape to the active popup's dismissal path. */
export function hasOpenTransientPopup(document: Document): boolean {
  return (scopes.get(document)?.popups.size ?? 0) > 0;
}

/** A popup must belong to the current modal, not to an inert background view. */
export function canOpenTransientPopup(owner: HTMLElement): boolean {
  if (!owner.isConnected || isHiddenOrInertInComposedTree(owner)) return false;
  const modal = activeModalElement(owner.ownerDocument);
  return modal === undefined || composedContains(modal, owner);
}

/** Register only while open; the returned cleanup never calls close itself. */
export function registerTransientPopup(owner: HTMLElement, close: () => void): () => void {
  if (!canOpenTransientPopup(owner)) {
    close();
    return () => { /* No live registration to release. */ };
  }
  const document = owner.ownerDocument;
  let scope = scopes.get(document);
  if (scope === undefined) {
    const popups = new Set<Popup>();
    const roots = new Map<Document | ShadowRoot, MutationObserver>();
    const refresh = (): void => {
      watch(document);
      for (const popup of [...popups]) {
        if (canOpenTransientPopup(popup.owner)) continue;
        popups.delete(popup);
        popup.close();
      }
      if (popups.size === 0) dispose();
    };
    const watch = (root: Document | ShadowRoot): void => {
      observeModalRoot(root);
      if (!roots.has(root)) {
        const observer = new MutationObserver(refresh);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "inert", "class", "style"] });
        roots.set(root, observer);
        // Native dialog focusing steps run after showModal establishes modality.
        root.addEventListener("focusin", refresh, true);
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot !== null) watch(element.shadowRoot);
      }
    };
    const unsubscribe = subscribeModalChanges((changedDocument) => {
      if (changedDocument === document) refresh();
    });
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [root, observer] of roots) {
        observer.disconnect();
        root.removeEventListener("focusin", refresh, true);
      }
      scopes.delete(document);
    };
    scope = { popups, dispose };
    scopes.set(document, scope);
    watch(document);
  }
  const popup = { owner, close };
  scope.popups.add(popup);
  const registrationScope = scope;
  return () => {
    registrationScope.popups.delete(popup);
    if (registrationScope.popups.size === 0) registrationScope.dispose();
  };
}
