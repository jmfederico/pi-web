import { describe, expect, it } from "vitest";
import { PendingFormState, type PendingFormIdentity } from "./pendingFormState";

const form = (scope = "machine:session", kind: PendingFormIdentity["kind"] = "dialog"): PendingFormIdentity => ({ scope, kind, requestId: "same-id" });

describe("PendingFormState", () => {
  it("locks before synchronous reentry, shares completion, and allows intentional retries", async () => {
    const state = new PendingFormState();
    let finish!: () => void;
    let calls = 0;
    let concurrent: Promise<void> | undefined;
    const first = state.runExclusive(form(), () => {
      calls++;
      concurrent = state.runExclusive(form(), () => { calls++; });
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    expect(concurrent).toBe(first);
    expect(calls).toBe(1);
    finish();
    await first;
    await state.runExclusive(form(), () => { calls++; });
    expect(calls).toBe(2);
  });

  it("isolates scopes and kinds and retains drafts after rejection", async () => {
    const state = new PendingFormState();
    state.setInput(form(), "secret");
    state.setAnswers(form("machine:session", "ask"), { q: { values: ["answer"] } });
    expect(state.get(form("other-machine:session")).input).toBe("");
    expect(state.get(form()).answers).toEqual({});
    await expect(state.runExclusive(form(), () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(state.get(form()).input).toBe("secret");
  });

  it("clears only authoritative dialog scopes and retains a closing lock until settlement", async () => {
    const state = new PendingFormState();
    let finish!: () => void;
    state.setInput(form(), "private");
    const operation = state.runExclusive(form(), () => new Promise<void>((resolve) => { finish = resolve; }));
    state.setInput(form("old"), "old");
    state.setInput(form("new"), "new");
    expect(state.get(form()).operation).toBe(operation);
    state.syncDialogs("other", []);
    expect(state.get(form()).input).toBe("private");
    state.syncDialogs("machine:session", []);
    expect(state.get(form()).input).toBe("");
    expect(state.get(form()).operation).toBe(operation);
    finish();
    await operation;
    expect(state.get(form("old")).input).toBe("old");
    expect(state.get(form()).operation).toBeUndefined();
  });

  it("retains a pending input draft while navigation unsubscribes its card", () => {
    const state = new PendingFormState();
    const stop = state.subscribe(form(), () => undefined);
    state.setInput(form(), "typed answer");
    stop();
    expect(state.get(form()).input).toBe("typed answer");
    state.syncDialogs(form().scope, []);
    expect(state.get(form()).input).toBe("");
  });

  it("promotes startup drafts and a pending operation without releasing its shared lock", async () => {
    const state = new PendingFormState();
    state.setInput(form("temporary"), "half typed");
    let finish!: () => void;
    const operation = state.runExclusive(form("temporary"), () => new Promise<void>((resolve) => { finish = resolve; }));
    let notices = 0;
    const unsubscribe = state.subscribe(form("temporary"), () => { notices++; });
    state.promoteScope("temporary", "ready");
    expect(state.get(form("ready")).input).toBe("half typed");
    expect(state.runExclusive(form("ready"), () => { throw new Error("duplicate"); })).toBe(operation);
    finish();
    await operation;
    expect(notices).toBe(1);
    unsubscribe();
    state.setInput(form("ready"), "continued");
    expect(notices).toBe(1);
  });

  it("clears accepted ask drafts without unlocking an operation still being reconciled", async () => {
    const state = new PendingFormState();
    const ask = form("scope", "ask");
    state.setAnswers(ask, { q: { values: ["answer"] } });
    let finish!: () => void;
    const operation = state.runExclusive(ask, () => new Promise<void>((resolve) => { finish = resolve; }));
    state.clearAsk("scope", ask.requestId);
    expect(state.get(ask).answers).toEqual({});
    expect(state.get(ask).operation).toBe(operation);
    finish();
    await operation;
  });

  it("does not retain historical reads or completed request owners", () => {
    const state = new PendingFormState();
    state.get(form("historical", "ask"));
    state.get(form("historical"));
    state.setInput(form("temporary"), "startup answer");
    expect(() => { state.promoteScope("temporary", "historical"); }).not.toThrow();
    state.forgetDialog("historical", form().requestId);
    state.setInput(form("next-start"), "next answer");
    expect(() => { state.promoteScope("next-start", "historical"); }).not.toThrow();
    expect(state.get(form("historical")).input).toBe("next answer");
  });

  it("notifies subscribed remounts and unsubscribes detached cards", async () => {
    const state = new PendingFormState();
    let notices = 0;
    const unsubscribe = state.subscribe(form(), () => { notices++; });
    state.setInput(form(), "draft");
    unsubscribe();
    await state.runExclusive(form(), () => Promise.resolve());
    expect(notices).toBe(1);
  });
});
