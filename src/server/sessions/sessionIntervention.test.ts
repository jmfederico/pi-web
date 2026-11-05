import { describe, expect, it } from "vitest";
import {
  interventionStateFromEntry,
  requestsHumanIntervention,
  SESSION_INTERVENTION_CUSTOM_TYPE,
  sessionInterventionRequired,
} from "./sessionIntervention.js";

function marker(required: boolean) {
  return { type: "custom", customType: SESSION_INTERVENTION_CUSTOM_TYPE, data: { version: 1, required } };
}

describe("requestsHumanIntervention", () => {
  it("accepts a successful generic tool signal independently of tool name or presentation", () => {
    for (const toolName of ["ask_user", "approval_gate", "unrelated_custom_tool", undefined]) {
      expect(requestsHumanIntervention({
        role: "toolResult", toolName, isError: false,
        content: [{ type: "text", text: "not a form" }],
        details: { interventionRequired: true },
      })).toBe(true);
    }
  });

  it("ignores failed results and values that do not explicitly signal successful intervention", () => {
    const signal = { role: "toolResult", isError: false, details: { interventionRequired: true } };
    for (const message of [
      { ...signal, isError: true },
      { ...signal, isError: undefined },
      { ...signal, role: "assistant" },
      { ...signal, details: { interventionRequired: false } },
      { ...signal, details: { interventionRequired: "true" } },
      { ...signal, details: undefined },
      { ...signal, details: [] },
      null,
    ]) {
      expect(requestsHumanIntervention(message)).toBe(false);
    }
  });
});

describe("persisted session intervention", () => {
  it("accepts versioned boolean transitions and rejects unrelated or malformed markers", () => {
    expect(interventionStateFromEntry(marker(true))).toBe(true);
    expect(interventionStateFromEntry(marker(false))).toBe(false);
    for (const entry of [
      null,
      [],
      { ...marker(true), type: "message" },
      { ...marker(true), customType: "other" },
      { ...marker(true), data: undefined },
      { ...marker(true), data: { required: true } },
      { ...marker(true), data: { version: 2, required: true } },
      { ...marker(true), data: { version: "1", required: true } },
      { ...marker(true), data: { version: 1, required: "true" } },
      { ...marker(true), data: { version: 1 } },
    ]) {
      expect(interventionStateFromEntry(entry)).toBeUndefined();
    }
  });

  it("uses the latest valid transition in file order rather than parent linkage", () => {
    const requested = { ...marker(true), id: "requested", parentId: "root" };
    // A new execution clears the state even if it is on a different transcript branch.
    const resumed = { ...marker(false), id: "resumed", parentId: "other-branch" };
    const requestedAgain = { ...marker(true), id: "again", parentId: "requested" };
    expect(sessionInterventionRequired([])).toBe(false);
    expect(sessionInterventionRequired([requested])).toBe(true);
    expect(sessionInterventionRequired([requested, resumed])).toBe(false);
    expect(sessionInterventionRequired([requested, resumed, requestedAgain])).toBe(true);
    expect(sessionInterventionRequired([
      requested,
      { type: "branch_summary", parentId: "root", summary: "navigate away" },
      { ...marker(false), data: { version: 99, required: false } },
      { type: "message", message: { role: "user", content: "bookkeeping is not execution" } },
    ])).toBe(true);
  });
});
