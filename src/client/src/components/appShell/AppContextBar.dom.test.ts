// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { html } from "lit";
import { AppContextBar } from "./AppContextBar";

afterEach(() => {
  document.body.replaceChildren();
});

describe("plugin header items in the context bar", () => {
  it("carries the items the panel header cannot show in the mobile layout", async () => {
    const bar = new AppContextBar();
    bar.headerItems = [{ id: "modes:header.switch", title: "Working mode", render: () => html`<button class="mode">Cowork</button>` }];
    document.body.append(bar);
    await bar.updateComplete;

    const group = bar.shadowRoot?.querySelector('.context-items [role="group"]');
    expect(group?.getAttribute("aria-label")).toBe("Working mode");
    expect(group?.querySelector("button.mode")?.textContent).toBe("Cowork");
  });
});
