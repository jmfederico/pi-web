import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSettingsSection, parseSettingsSection, readSettingsSection, writeSettingsSection } from "./settingsRoute";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

function installWindow(href: string): { pushed: string[]; replaced: string[] } {
  const url = new URL(href);
  const pushed: string[] = [];
  const replaced: string[] = [];
  const fakeWindow = {
    location: {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
    history: {
      pushState: vi.fn((_state: object, _title: string, next: URL | string) => {
        pushed.push(String(next));
      }),
      replaceState: vi.fn((_state: object, _title: string, next: URL | string) => {
        replaced.push(String(next));
      }),
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  return { pushed, replaced };
}

describe("settings route helpers", () => {
  it("parses supported settings deep links and aliases", () => {
    expect(parseSettingsSection("general")).toBe("general");
    expect(parseSettingsSection("sessiond")).toBe("sessiond");
    expect(parseSettingsSection("sessions")).toBe("sessiond");
    expect(parseSettingsSection("packages")).toBe("packages");
    expect(parseSettingsSection("pi-packages")).toBe("packages");
    expect(parseSettingsSection("plugins")).toBe("plugins");
    expect(parseSettingsSection("safe-tunnel")).toBe("safe-tunnel");
    expect(parseSettingsSection("safeTunnel")).toBe("safe-tunnel");
    expect(parseSettingsSection("tunnel")).toBe("safe-tunnel");
    expect(parseSettingsSection("shortcuts")).toBe("shortcuts");
    expect(parseSettingsSection("keyboard")).toBe("shortcuts");
    expect(parseSettingsSection("unknown")).toBeUndefined();
  });

  it("fails a Safe Tunnel request closed to ordinary settings until active", () => {
    expect(normalizeSettingsSection("safe-tunnel", false)).toBe("general");
    expect(normalizeSettingsSection("safe-tunnel", true)).toBe("safe-tunnel");
    expect(normalizeSettingsSection("plugins", false)).toBe("plugins");
    expect(normalizeSettingsSection(undefined, false)).toBeUndefined();
  });

  it("reads the settings section from the current URL", () => {
    installWindow("http://localhost/app?project=p1&settings=shortcuts");

    expect(readSettingsSection()).toBe("shortcuts");
  });

  it("writes settings deep links while preserving other route fields", () => {
    const { pushed } = installWindow("http://localhost/app?project=p1#bottom");

    writeSettingsSection("general");

    expect(pushed).toEqual(["http://localhost/app?project=p1&settings=general#bottom"]);
  });

  it("removes settings deep links with replace when closing", () => {
    const { replaced } = installWindow("http://localhost/app?project=p1&settings=general#bottom");

    writeSettingsSection(undefined, { replace: true });

    expect(replaced).toEqual(["http://localhost/app?project=p1#bottom"]);
  });
});
