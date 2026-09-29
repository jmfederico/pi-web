import { describe, expect, it } from "vitest";
import { RenderIntentMemory } from "./renderIntentMemory";

const preview = { rendererId: "a", raw: false };
describe("render intent memory", () => {
  it("expires from the last choice, never from access, and renews only on choice", () => {
    let now = 0;
    const memory = new RenderIntentMemory(() => now);
    memory.choose("block", "source", preview);
    now = 14 * 60_000;
    expect(memory.read("block", "source", ["a"])).toEqual(preview);
    now = 15 * 60_000;
    expect(memory.read("block", "source", ["a"])).toBeUndefined();
    memory.choose("block", "source", preview);
    now += 14 * 60_000;
    memory.choose("block", "source", { ...preview, raw: true });
    now += 14 * 60_000;
    expect(memory.read("block", "source", ["a"])?.raw).toBe(true);
  });

  it("invalidates changed source and unavailable renderers permanently", () => {
    const memory = new RenderIntentMemory();
    memory.choose("block", "source", preview);
    expect(memory.read("block", "changed", ["a"])).toBeUndefined();
    expect(memory.read("block", "source", ["a"])).toBeUndefined();
    memory.choose("block", "source", preview);
    expect(memory.read("block", "source", ["b"])).toBeUndefined();
    expect(memory.read("block", "source", ["a", "b"])).toBeUndefined();
  });

  it("bounds entries by choice age without promoting reads or merging duplicate sources", () => {
    const memory = new RenderIntentMemory(() => 0, 2);
    memory.choose("one", "same", preview);
    memory.choose("two", "same", { ...preview, raw: true });
    expect(memory.read("one", "same", ["a"])).toEqual(preview);
    memory.choose("three", "same", preview);
    expect(memory.read("one", "same", ["a"])).toBeUndefined();
    expect(memory.read("two", "same", ["a"])?.raw).toBe(true);
  });
});
