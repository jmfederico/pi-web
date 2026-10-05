// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { ExtensionStatusStrip } from "./ExtensionStatusStrip";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ExtensionStatusStrip", () => {
  it("renders an explicit empty state without implying a healthy extension", async () => {
    const strip = new ExtensionStatusStrip();
    document.body.append(strip);
    await strip.updateComplete;

    expect(strip.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe("No extension status reported");
  });

  it("renders labelled status text as escaped, sorted content", async () => {
    const strip = new ExtensionStatusStrip();
    strip.statuses = {
      worker: "running <img src=x onerror=alert(1)>",
      alpha: "<script>not markup</script>",
    };
    document.body.append(strip);
    await strip.updateComplete;

    const rows = Array.from(strip.shadowRoot?.querySelectorAll(".status") ?? []);
    expect(rows.map((row) => row.textContent)).toEqual([
      "alpha: <script>not markup</script>",
      "worker: running <img src=x onerror=alert(1)>",
    ]);
    expect(strip.shadowRoot?.querySelector("img, script")).toBeNull();
    expect(strip.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("Extension status");
  });
});
