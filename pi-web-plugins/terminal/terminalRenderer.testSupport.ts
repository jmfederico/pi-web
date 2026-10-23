import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import * as xterm from "@xterm/xterm";
import { vi } from "vitest";

/** Replace only Xterm's renderer; retain the real panel and host update lifecycle. */
export function installTerminalRendererFake() {
  const terminals: { options: ITerminalOptions; dispose: ReturnType<typeof vi.fn> }[] = [];
  class FakeTerminal {
    options: ITerminalOptions;
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    focus = vi.fn();
    constructor(options: ITerminalOptions = {}) {
      this.options = options;
      terminals.push(this);
    }
  }
  // The fake implements only the external rendering boundary exercised here.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  vi.spyOn(xterm, "Terminal").mockImplementation(FakeTerminal as unknown as typeof Terminal);
  vi.stubGlobal("IntersectionObserver", undefined);
  return terminals;
}
