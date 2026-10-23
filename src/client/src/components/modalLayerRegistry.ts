interface RenderedModalLayer {
  /** Native dialog whose composed subtree owns this modal's interaction. */
  element: HTMLDialogElement;
  /** Apply this layer's viable focus target when it becomes visually topmost. */
  focus: () => void;
  /** Keep layer-specific accessibility state in sync with visual ownership. */
  onTopChange?: (isTop: boolean) => void;
}

export interface RenderedModalRegistration {
  readonly isTop: boolean;
  focus: () => boolean;
  unregister: () => void;
}

interface RegisteredModalLayer {
  layer: RenderedModalLayer;
  order: number;
  restorationPath: HTMLElement[];
}

const registeredModalLayers = new Set<RegisteredModalLayer>();
let modalLayerOrder = 0;
const nativeLayers = new WeakMap<HTMLDialogElement, RegisteredModalLayer>();
const modalListeners = new Set<(ownerDocument: Document) => void>();

/** Subscribe while a transient surface needs proactive modality updates. */
export function subscribeModalChanges(listener: (ownerDocument: Document) => void): () => void {
  modalListeners.add(listener);
  return () => { modalListeners.delete(listener); };
}

/** The actual interaction owner, including framework-neutral plugin dialogs. */
export function activeModalElement(ownerDocument: Document): HTMLElement | undefined {
  return topModalLayer(ownerDocument)?.layer.element;
}

/** Prefer :modal so an ordinary dialog.show() does not acquire modality. */
function isNativeModal(dialog: HTMLDialogElement): boolean {
  if (!dialog.open || !dialog.isConnected) return false;
  try { return dialog.matches(":modal"); }
  catch {
    // Older engines cannot distinguish show() from showModal(); fail closed.
    return true;
  }
}

const observedRoots = new WeakSet<Document | ShadowRoot>();

/** beforetoggle does not cross shadow boundaries; watch each discovered root. */
export function observeModalRoot(root: Document | ShadowRoot): void {
  if (observedRoots.has(root)) return;
  observedRoots.add(root);
  root.addEventListener("beforetoggle", (event) => {
    const dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement)) return;
    if ("newState" in event && event.newState === "open") {
      nativeLayers.set(dialog, {
        layer: { element: dialog, focus: () => { dialog.focus(); } },
        order: ++modalLayerOrder,
        restorationPath: [],
      });
    }
    // showModal has not established :modal during beforetoggle. Wait until the
    // native operation finishes, rather than mistaking dialog.show() for it.
    queueMicrotask(() => { notifyModalLayers(dialog.ownerDocument); });
  }, true);
}

function nativeModalLayers(root: Document | ShadowRoot): RegisteredModalLayer[] {
  observeModalRoot(root);
  const layers: RegisteredModalLayer[] = [];
  for (const element of root.querySelectorAll("*")) {
    if (element instanceof HTMLDialogElement) {
      if (isNativeModal(element)) {
        let layer = nativeLayers.get(element);
        if (layer === undefined) {
          layer = { layer: { element, focus: () => { element.focus(); } }, order: ++modalLayerOrder, restorationPath: [] };
          nativeLayers.set(element, layer);
        }
        layers.push(layer);
      } else {
        nativeLayers.delete(element);
      }
    }
    if (element.shadowRoot !== null) layers.push(...nativeModalLayers(element.shadowRoot));
  }
  return layers;
}

/**
 * Register a rendered modal layer with the document-wide modality and focus
 * boundary. Registrations are owned by the component that renders the layer
 * and must be removed when that rendered layer closes or disconnects.
 */
export function registerRenderedModal(layer: RenderedModalLayer): RenderedModalRegistration {
  const ownerDocument = layer.element.ownerDocument;
  // Observe already-active native dialogs before assigning this layer's order.
  nativeModalLayers(ownerDocument);
  const previous = deepActiveElement(ownerDocument);
  const lowerLayer = previous instanceof HTMLElement ? containingModalLayer(ownerDocument, previous) : undefined;
  const registered: RegisteredModalLayer = {
    layer,
    order: ++modalLayerOrder,
    restorationPath: previous instanceof HTMLElement
      ? [previous, ...(lowerLayer?.restorationPath ?? [])]
      : [],
  };
  let active = true;

  registeredModalLayers.add(registered);
  notifyModalLayers(ownerDocument);

  return {
    get isTop() {
      return active && topModalLayer(ownerDocument) === registered;
    },
    focus: () => active && focusModalLayer(registered),
    unregister: () => {
      if (!active) return;
      active = false;
      registeredModalLayers.delete(registered);
      notifyModalLayers(ownerDocument);
      restoreAfterModalClose(registered);
    },
  };
}

/** True while a rendered app layer or native modal owns interaction. */
export function hasRenderedModal(ownerDocument: Document | undefined): boolean {
  return ownerDocument !== undefined
    && topModalLayer(ownerDocument) !== undefined;
}

function restoreAfterModalClose(registered: RegisteredModalLayer): void {
  const { element } = registered.layer;
  const ownerDocument = element.ownerDocument;
  const active = deepActiveElement(ownerDocument);
  const focusWasReset = active === null || active === ownerDocument.body || active === ownerDocument.documentElement;
  // A newer or otherwise unrelated layer owns focus; closing this layer must
  // not pull focus away from it.
  if (!focusWasReset && !composedContains(element, active)) return;

  const lowerLayer = topModalLayer(ownerDocument);
  if (lowerLayer !== undefined) {
    const rememberedInsideLower = registered.restorationPath.filter((target) => composedContains(lowerLayer.layer.element, target));
    if (restoreFocus(rememberedInsideLower)) return;
    focusModalLayer(lowerLayer);
    return;
  }
  restoreFocus(registered.restorationPath);
}

function notifyModalLayers(ownerDocument: Document): void {
  const top = topModalLayer(ownerDocument);
  for (const registered of [...registeredModalLayers]) {
    if (registered.layer.element.ownerDocument === ownerDocument) registered.layer.onTopChange?.(registered === top);
  }
  for (const listener of modalListeners) listener(ownerDocument);
}

function topModalLayer(ownerDocument: Document): RegisteredModalLayer | undefined {
  let top: RegisteredModalLayer | undefined;
  for (const native of nativeModalLayers(ownerDocument)) {
    const registered = [...registeredModalLayers].find((entry) => entry.layer.element === native.layer.element);
    const candidate = registered ?? native;
    candidate.order = native.order;
    if (top === undefined || candidate.order > top.order) top = candidate;
  }
  return top;
}

function containingModalLayer(ownerDocument: Document, node: Element): RegisteredModalLayer | undefined {
  let top: RegisteredModalLayer | undefined;
  for (const registered of registeredModalLayers) {
    if (registered.layer.element.ownerDocument !== ownerDocument || !isNativeModal(registered.layer.element)
      || !composedContains(registered.layer.element, node)) continue;
    registered.order = nativeLayers.get(registered.layer.element)?.order ?? registered.order;
    if (top === undefined || registered.order > top.order) top = registered;
  }
  return top;
}

function focusModalLayer(registered: RegisteredModalLayer): boolean {
  if (topModalLayer(registered.layer.element.ownerDocument) !== registered) return false;
  registered.layer.focus();
  const active = deepActiveElement(registered.layer.element.ownerDocument);
  return active !== null && composedContains(registered.layer.element, active);
}

function restoreFocus(path: readonly HTMLElement[]): boolean {
  for (const target of path) {
    if (focusElement(target)) return true;
  }
  return false;
}

export function focusElement(target: HTMLElement): boolean {
  if (!target.isConnected || target.matches(":disabled") || isHiddenOrInertInComposedTree(target)) return false;
  target.focus();
  const active = deepActiveElement(target.ownerDocument);
  return active === target || (active !== null && composedContains(target, active));
}

/** Deepest element holding focus, resolving through nested shadow roots. */
export function deepActiveElement(ownerDocument: Document): Element | null {
  let active: Element | null = ownerDocument.activeElement;
  while (active instanceof HTMLElement) {
    const deeper: Element | null = active.shadowRoot?.activeElement ?? null;
    if (deeper === null) return active;
    active = deeper;
  }
  // happy-dom reports activeElement as undefined when nothing is focused;
  // normalize that runtime value even though the DOM type says Element | null.
  return active ?? null;
}

/** Hidden/inert content is unavailable as a viable focus target. */
export function isHiddenOrInertInComposedTree(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  const elementStyle = view?.getComputedStyle(element);
  if (elementStyle?.visibility === "hidden" || elementStyle?.visibility === "collapse") return true;

  let current: Element | null = element;
  while (current !== null) {
    if (current.hasAttribute("hidden") || current.hasAttribute("inert")) return true;
    const style = view?.getComputedStyle(current);
    if (style?.display === "none" || style?.getPropertyValue("content-visibility") === "hidden") return true;
    current = composedParentElement(current);
  }
  return false;
}

function composedParentElement(element: Element): Element | null {
  const assignedSlot = element.assignedSlot;
  if (assignedSlot instanceof HTMLSlotElement) return assignedSlot;
  const parent = element.parentElement;
  if (parent instanceof Element) return parent;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof Element ? root.host : null;
}

/** Whether `node` is contained in `host` across open shadow boundaries. */
export function composedContains(host: Element, node: Element): boolean {
  let current: Element | null = node;
  while (current !== null) {
    if (current === host) return true;
    const parent = composedParentElement(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}
