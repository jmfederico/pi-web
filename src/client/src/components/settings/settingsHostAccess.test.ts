import { expect, it } from "vitest";
import { hostAccessChangeBlocksHostname } from "./settingsHostAccess";

const restricted = { mode: "restricted", hosts: ["other.test"] } as const;
const defaults = { hostAccess: { mode: "restricted" as const, hosts: [...restricted.hosts] } };

it("checks only a policy change in the filtered write, not unrelated settings", () => {
  expect(hostAccessChangeBlocksHostname({ set: { port: 9000 } }, defaults, "pi.test")).toBe(false);
  expect(hostAccessChangeBlocksHostname({ set: { hostAccess: defaults.hostAccess } }, undefined, "pi.test")).toBe(true);
  expect(hostAccessChangeBlocksHostname({ set: { hostAccess: { mode: "any" } } }, defaults, "pi.test")).toBe(false);
});

it("checks inherited policy when resetting, and allows reset to undecided", () => {
  const update = { unset: ["/hostAccess"] };
  expect(hostAccessChangeBlocksHostname(update, defaults, "pi.test")).toBe(true);
  expect(hostAccessChangeBlocksHostname(update, defaults, "other.test")).toBe(false);
  expect(hostAccessChangeBlocksHostname(update, undefined, "pi.test")).toBe(false);
});
