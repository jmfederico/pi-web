import { describe, expect, it } from "vitest";
import { moveOrderedId, orderItems } from "./navigationOrder";

describe("navigation order helpers", () => {
  it("orders known IDs first and keeps the default unlisted order without mutating input", () => {
    const items = [{ id: "c" }, { id: "a" }, { id: "d" }, { id: "b" }];
    expect(orderItems(items, ["missing", "b", "a", "b"]).map((item) => item.id)).toEqual(["b", "a", "c", "d"]);
    expect(items.map((item) => item.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("moves around visible neighbors while retaining hidden IDs and appending newcomers", () => {
    expect(moveOrderedId(["a", "hidden", "b"], ["a", "b", "c"], "b", "a", "before"))
      .toEqual(["b", "a", "hidden", "c"]);
    expect(moveOrderedId(["a", "hidden", "b"], ["a", "b", "c"], "a", "b", "after"))
      .toEqual(["hidden", "b", "a", "c"]);
  });

  it("does not delete temporarily missing IDs on a no-op or refresh", () => {
    expect(moveOrderedId(["missing", "a"], ["a", "new"], "a", "absent", "before"))
      .toEqual(["missing", "a", "new"]);
    expect(orderItems([{ id: "a" }], ["missing", "a"])).toEqual([{ id: "a" }]);
    expect(orderItems([{ id: "a" }, { id: "missing" }], ["missing", "a"]).map((item) => item.id))
      .toEqual(["missing", "a"]);
  });
});
