// @vitest-environment happy-dom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorBanner } from "./errorBanner";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function renderBanner(
  error: string,
  onDismiss = vi.fn(),
  severity: "info" | "warning" | "error" = "error",
  onRetry?: () => void,
): { host: HTMLElement; onDismiss: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  render(errorBanner(error, onDismiss, severity, onRetry), host);
  return { host, onDismiss };
}

describe("errorBanner", () => {
  it("renders nothing when there is no error, even if retry is supplied", () => {
    const { host } = renderBanner("", vi.fn(), "error", vi.fn());

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

  it("does not offer retry by default", () => {
    const { host } = renderBanner("Could not refresh the browser state");

    expect(host.querySelector(".error-retry")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });

  it.each(["info", "warning", "error"] as const)("offers retry without dismissing %s banners", (severity) => {
    const onRetry = vi.fn();
    const { host, onDismiss } = renderBanner("Could not refresh the browser state", vi.fn(), severity, onRetry);
    const banner = host.querySelector(".error");
    const retry = host.querySelector<HTMLButtonElement>(".error-retry");
    const dismiss = host.querySelector<HTMLButtonElement>(".error-dismiss");

    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.classList.contains(severity)).toBe(true);
    expect(retry?.textContent).toBe("Retry");
    expect(retry?.type).toBe("button");
    expect(dismiss?.getAttribute("aria-label")).toBe(`Dismiss ${severity}`);
    expect(dismiss?.getAttribute("title")).toBe(`Dismiss ${severity}`);

    retry?.click();

    expect(onRetry).toHaveBeenCalledExactlyOnceWith();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(host.querySelector(".error")).toBe(banner);

    dismiss?.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(["info", "warning"] as const)("uses the severity-aware presentation for %s notices", (severity) => {
    const { host } = renderBanner("Server notice", vi.fn(), severity);
    const banner = host.querySelector(".error");

    expect(banner?.classList.contains(severity)).toBe(true);
    expect(banner?.querySelector(".error-dismiss")?.getAttribute("aria-label")).toBe(`Dismiss ${severity}`);
  });
});
