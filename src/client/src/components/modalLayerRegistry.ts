interface RenderedModalLayer {
  /** Connected element whose composed subtree owns this modal's focus. */
  element: HTMLElement;
  /** Element that establishes this custom layer's z-index and paint order. */
  paintElement?: HTMLElement;
  /**
   * Native modal dialogs render in the browser's top layer above custom
   * overlays and hold modality from `showModal()` until `close()`.
   */
  nativeTopLayer?: boolean;
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

/**
 * Register a rendered modal layer with the document-wide modality and focus
 * boundary. Registrations are owned by the component that renders the layer
 * and must be removed when that rendered layer closes or disconnects.
 */
export function registerRenderedModal(layer: RenderedModalLayer): RenderedModalRegistration {
  const ownerDocument = layer.element.ownerDocument;
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

/**
 * True while a registered app layer or an open native dialog in any composed
 * subtree owns interaction. Browser plugins cannot import the private modal
 * registry, so native `<dialog>.showModal()` is the public, framework-neutral
 * modality boundary. Treating every open native dialog conservatively avoids
 * missing that boundary in DOM implementations without `:modal` support.
 */
export function hasRenderedModal(ownerDocument: Document | undefined): boolean {
  return ownerDocument !== undefined
    && (topModalLayer(ownerDocument) !== undefined || hasComposedOpenDialog(ownerDocument));
}

function hasComposedOpenDialog(root: Document | ShadowRoot): boolean {
  if (root.querySelector("dialog[open]") !== null) return true;
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot !== null && hasComposedOpenDialog(element.shadowRoot)) return true;
  }
  return false;
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
}

function topModalLayer(ownerDocument: Document): RegisteredModalLayer | undefined {
  let top: RegisteredModalLayer | undefined;
  for (const registered of registeredModalLayers) {
    if (!isRenderedModalLayer(ownerDocument, registered)) continue;
    if (top === undefined || compareModalPaintOrder(registered, top) > 0) top = registered;
  }
  return top;
}

/**
 * A registered layer owns modality only while it is actually rendered. A view
 * switch or responsive CSS can hide a still-connected custom layer - the
 * workspace upload review disappears with its panel when the main view leaves
 * the workspace - and a hidden layer that kept counting would suppress global
 * shortcuts, prompt focus, and unread acknowledgement with nothing on screen to
 * dismiss and no obvious recovery.
 *
 * Native top-layer dialogs are exempt: their modality belongs to the browser
 * from `showModal()` until `close()`, and hosts must register before that call
 * to capture the pre-modal focus target, while the dialog is still hidden as an
 * unopened `dialog` element.
 */
function isRenderedModalLayer(ownerDocument: Document, registered: RegisteredModalLayer): boolean {
  const { element, nativeTopLayer } = registered.layer;
  if (!element.isConnected || element.ownerDocument !== ownerDocument) return false;
  return nativeTopLayer === true || !isHiddenOrInertInComposedTree(element);
}

function containingModalLayer(ownerDocument: Document, node: Element): RegisteredModalLayer | undefined {
  let top: RegisteredModalLayer | undefined;
  for (const registered of registeredModalLayers) {
    if (!isRenderedModalLayer(ownerDocument, registered)
      || !composedContains(registered.layer.element, node)) continue;
    if (top === undefined || compareModalPaintOrder(registered, top) > 0) top = registered;
  }
  return top;
}

/** Compare native top-layer ownership, then custom z-index and paint order. */
function compareModalPaintOrder(left: RegisteredModalLayer, right: RegisteredModalLayer): number {
  const nativeLayerDifference = Number(left.layer.nativeTopLayer === true) - Number(right.layer.nativeTopLayer === true);
  if (nativeLayerDifference !== 0) return nativeLayerDifference;

  const leftPaintElement = left.layer.paintElement ?? left.layer.element;
  const rightPaintElement = right.layer.paintElement ?? right.layer.element;
  const layerDifference = modalLayerZIndex(leftPaintElement) - modalLayerZIndex(rightPaintElement);
  if (layerDifference !== 0) return layerDifference;
  if (leftPaintElement !== rightPaintElement) {
    const position = leftPaintElement.compareDocumentPosition(rightPaintElement);
    if ((position & Node.DOCUMENT_POSITION_DISCONNECTED) === 0) {
      if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
      if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
    }
  }
  return left.order - right.order;
}

function modalLayerZIndex(element: HTMLElement): number {
  const value = element.ownerDocument.defaultView?.getComputedStyle(element).zIndex ?? "";
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  let current: Node = node;
  for (;;) {
    if (current === host) return true;
    // happy-dom reports missing or bogus parents (undefined, or even the node
    // itself) at shadow boundaries, so guard the plain DOM climb carefully.
    const parent: Node | null = current.parentNode;
    if (parent != null && parent !== current) {
      current = parent;
      continue;
    }
    const root = current instanceof ShadowRoot ? current : current.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    current = root.host;
  }
}
