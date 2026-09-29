// @vitest-environment happy-dom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorBanner } from "./errorBanner";

afterEach(() => {
  document.body.replaceChildren();
});

function renderBanner(error: string, onDismiss = vi.fn(), severity: "info" | "warning" | "error" = "error"): { host: HTMLElement; onDismiss: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  render(errorBanner(error, onDismiss, severity), host);
  return { host, onDismiss };
}

describe("errorBanner", () => {
  it("renders nothing when there is no error", () => {
    const { host } = renderBanner("");

    expect(host.querySelector(".error")).toBeNull();
  });

  it("announces the message and dismisses it on request", () => {
    const { host, onDismiss } = renderBanner("Failed to start workspace removal: HTTP request cancelled");

    const banner = host.querySelector(".error");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Failed to start workspace removal: HTTP request cancelled");

    const dismiss = host.querySelector<HTMLButtonElement>(".error-dismiss");
    expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss error");
    dismiss?.click();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each(["info", "warning"] as const)("uses the severity-aware presentation for %s notices", (severity) => {
    const { host } = renderBanner("Server notice", vi.fn(), severity);
    const banner = host.querySelector(".error");

    expect(banner?.classList.contains(severity)).toBe(true);
    expect(banner?.querySelector(".error-dismiss")?.getAttribute("aria-label")).toBe(`Dismiss ${severity}`);
  });
});
