import { describe, expect, it } from "vitest";
import { lintBatches } from "./typescriptAreas.mjs";

describe("lint batches", () => {
  it("lints a file shared by several areas once, with the first area", () => {
    const batches = lintBatches([
      { name: "client", files: ["env.d.ts", "client.ts"] },
      { name: "server", files: ["env.d.ts", "server.ts"] },
    ]);

    expect(batches).toEqual([
      { area: "client", files: ["env.d.ts", "client.ts"] },
      { area: "server", files: ["server.ts"] },
    ]);
  });

  it("splits a long file list without dropping or repeating files", () => {
    const files = ["aaaa.ts", "bbbb.ts", "cccc.ts", "dddd.ts", "eeee.ts"];

    const batches = lintBatches([{ name: "server", files }], 16);

    expect(batches.map((batch) => batch.files)).toEqual([["aaaa.ts", "bbbb.ts"], ["cccc.ts", "dddd.ts"], ["eeee.ts"]]);
    expect(batches.every((batch) => batch.area === "server")).toBe(true);
  });
});
