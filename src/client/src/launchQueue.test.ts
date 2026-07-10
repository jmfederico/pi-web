import { describe, expect, it, vi } from "vitest";
import { installLaunchQueueConsumer, type LaunchQueue } from "./launchQueue";

describe("installLaunchQueueConsumer", () => {
  it("does nothing when launchQueue is unsupported", () => {
    const onLaunch = vi.fn();
    expect(() => { installLaunchQueueConsumer(onLaunch, {}); }).not.toThrow();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("invokes the callback with the parsed target URL", () => {
    let consumer: ((params: { targetURL?: string }) => void) | undefined;
    const launchQueue: LaunchQueue = { setConsumer: (fn) => { consumer = fn; } };
    const onLaunch = vi.fn();

    installLaunchQueueConsumer(onLaunch, { launchQueue });
    consumer?.({ targetURL: "https://pi.example/?shortcut=continue-last" });

    expect(onLaunch).toHaveBeenCalledWith(new URL("https://pi.example/?shortcut=continue-last"));
  });

  it("ignores launch params without a targetURL", () => {
    let consumer: ((params: { targetURL?: string }) => void) | undefined;
    const launchQueue: LaunchQueue = { setConsumer: (fn) => { consumer = fn; } };
    const onLaunch = vi.fn();

    installLaunchQueueConsumer(onLaunch, { launchQueue });
    consumer?.({});

    expect(onLaunch).not.toHaveBeenCalled();
  });
});
