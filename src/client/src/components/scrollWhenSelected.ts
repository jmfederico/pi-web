import { Directive, PartType, directive, type Part, type PartInfo } from "lit/directive.js";

class ScrollWhenSelectedDirective extends Directive {
  private readonly isElementPart: boolean;
  private wasSelected = false;
  private previousKey: unknown;

  constructor(partInfo: PartInfo) {
    super(partInfo);
    this.isElementPart = partInfo.type === PartType.ELEMENT;
  }

  override update(part: Part, [selected, key]: [boolean, unknown?]) {
    if (!this.isElementPart) throw new Error("scrollWhenSelected must be used on an element");
    if (selected && (!this.wasSelected || key !== this.previousKey)) {
      const element = "element" in part ? part.element : undefined;
      requestAnimationFrame(() => {
        if (element instanceof HTMLElement) element.scrollIntoView({ block: "nearest" });
      });
    }
    this.wasSelected = selected;
    this.previousKey = key;
    return undefined;
  }

  override render(selected: boolean, key?: unknown) {
    void selected;
    void key;
    return undefined;
  }
}

export const scrollWhenSelected = directive(ScrollWhenSelectedDirective);
