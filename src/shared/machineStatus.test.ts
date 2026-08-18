import { describe, expect, it } from "vitest";
import { CORE_STATUS_FLAGS, parseMachineStatusSnapshot, rollUpStatusFlags } from "./machineStatus";

const snapshotWire = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  epochId: "epoch-1",
  revision: 4,
  machine: { [CORE_STATUS_FLAGS.working]: true },
  projects: { "project-1": { [CORE_STATUS_FLAGS.working]: true } },
  workspaces: { "workspace-1": { [CORE_STATUS_FLAGS.working]: true } },
  unattributed: {},
  generatedAt: "2024-05-01T10:00:00.000Z",
  ...overrides,
});

describe("rollUpStatusFlags", () => {
  it("sets a parent flag when any child has it and omits unset flags", () => {
    const rolled = rollUpStatusFlags([
      { [CORE_STATUS_FLAGS.working]: false, [CORE_STATUS_FLAGS.unread]: true },
      { [CORE_STATUS_FLAGS.working]: true },
    ]);

    expect(rolled).toEqual({ [CORE_STATUS_FLAGS.working]: true, [CORE_STATUS_FLAGS.unread]: true });
  });

  it("rolls equal status up to structurally equal parents so publication can compare trees", () => {
    const quiet = rollUpStatusFlags([{ [CORE_STATUS_FLAGS.terminal]: false }]);

    expect(quiet).toEqual({});
    expect(rollUpStatusFlags([])).toEqual(quiet);
  });

  it("keeps unknown flag ids from a newer daemon", () => {
    expect(rollUpStatusFlags([{ "core:future": true }])).toEqual({ "core:future": true });
  });
});

describe("parseMachineStatusSnapshot", () => {
  it("parses a complete snapshot", () => {
    expect(parseMachineStatusSnapshot(snapshotWire())).toEqual({
      epochId: "epoch-1",
      revision: 4,
      machine: { [CORE_STATUS_FLAGS.working]: true },
      projects: { "project-1": { [CORE_STATUS_FLAGS.working]: true } },
      workspaces: { "workspace-1": { [CORE_STATUS_FLAGS.working]: true } },
      unattributed: {},
      generatedAt: "2024-05-01T10:00:00.000Z",
    });
  });

  it("rejects a payload that cannot be ordered or rendered", () => {
    expect(parseMachineStatusSnapshot(undefined)).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ epochId: "" }))).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ revision: "4" }))).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ revision: Number.NaN }))).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ generatedAt: "" }))).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ machine: null }))).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ unattributed: "none" }))).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ projects: [] }))).toBeUndefined();
    expect(parseMachineStatusSnapshot(snapshotWire({ workspaces: 3 }))).toBeUndefined();
  });

  it("keeps an unknown flag id alongside known ones instead of failing the payload", () => {
    const parsed = parseMachineStatusSnapshot(snapshotWire({
      machine: { [CORE_STATUS_FLAGS.working]: true, "core:future": true },
      projects: { "project-1": { "core:future": true } },
    }));

    expect(parsed?.machine).toEqual({ [CORE_STATUS_FLAGS.working]: true, "core:future": true });
    expect(parsed?.projects["project-1"]).toEqual({ "core:future": true });
  });

  it("drops flag entries that are not booleans and nodes that carry no flag map", () => {
    const parsed = parseMachineStatusSnapshot(snapshotWire({
      machine: { [CORE_STATUS_FLAGS.working]: true, "core:future": { level: 2 } },
      workspaces: { "workspace-1": { [CORE_STATUS_FLAGS.unread]: true }, "workspace-2": "busy" },
    }));

    expect(parsed?.machine).toEqual({ [CORE_STATUS_FLAGS.working]: true });
    expect(parsed?.workspaces).toEqual({ "workspace-1": { [CORE_STATUS_FLAGS.unread]: true } });
  });

  it("treats a prototype-shaped flag id from a remote daemon as ordinary data", () => {
    const machine = {};
    Object.defineProperty(machine, "__proto__", { value: true, enumerable: true, configurable: true, writable: true });
    const parsed = parseMachineStatusSnapshot(snapshotWire({ machine }));

    expect(Object.getPrototypeOf(parsed?.machine)).toBe(Object.prototype);
    expect(Object.entries(parsed?.machine ?? {})).toEqual([["__proto__", true]]);
  });
});
