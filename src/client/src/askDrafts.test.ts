import { afterEach, describe, expect, it } from "vitest";
import { ASK_USER_OTHER_TEXT_MAX_LENGTH, type AskUserQuestion } from "../../shared/apiTypes";
import { answeredCount, clearAskDraft, loadAskDraft, saveAskDraft, toSubmission, unansweredQuestions, type AskDraftAnswers } from "./askDrafts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error("storage blocked");
  }

  override setItem(): void {
    throw new Error("storage blocked");
  }

  override removeItem(): void {
    throw new Error("storage blocked");
  }
}

const singleSelect: AskUserQuestion = {
  id: "q1",
  question: "Which database?",
  options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }],
};

const multiSelect: AskUserQuestion = {
  id: "q2",
  question: "Which extras?",
  options: [{ value: "metrics", label: "Metrics" }, { value: "tracing", label: "Tracing" }],
  multiple: true,
};

const freeTextOnly: AskUserQuestion = {
  id: "q3",
  question: "Anything else?",
  options: [],
};

const questions = [singleSelect, multiSelect, freeTextOnly];

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
});

describe("ask draft storage", () => {
  it("round-trips a draft under a session- and ask-scoped key", () => {
    const storage = new MemoryStorage();
    const answers: AskDraftAnswers = { q1: { values: ["pg"] }, q2: { values: ["metrics"], otherText: "audit log" } };

    saveAskDraft("local:s1", "ask-1", answers, storage);

    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1")).not.toBeNull();
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual(answers);
    // Another ask of the same session, and the same ask of another session, are
    // separate drafts.
    expect(loadAskDraft("local:s1", "ask-2", storage)).toEqual({});
    expect(loadAskDraft("local:s2", "ask-1", storage)).toEqual({});
  });

  it("removes the entry rather than storing a draft that says nothing", () => {
    const storage = new MemoryStorage();
    saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, storage);

    saveAskDraft("local:s1", "ask-1", { q1: { values: [], otherText: "" } }, storage);

    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1")).toBeNull();
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});
  });

  it("clears a draft once its ask is closed", () => {
    const storage = new MemoryStorage();
    saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, storage);

    clearAskDraft("local:s1", "ask-1", storage);

    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});
  });

  it("treats unreadable and malformed drafts as empty instead of failing", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web:ask-draft:local:s1:ask-1", "{not json");
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});

    storage.setItem("pi-web:ask-draft:local:s1:ask-1", JSON.stringify({ q1: { values: "pg" }, q2: { values: ["metrics"] }, q3: 7 }));
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({ q2: { values: ["metrics"] } });

    const throwing = new ThrowingStorage();
    expect(loadAskDraft("local:s1", "ask-1", throwing)).toEqual({});
    expect(() => { saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, throwing); }).not.toThrow();
    expect(() => { clearAskDraft("local:s1", "ask-1", throwing); }).not.toThrow();
  });

  it("does nothing when the browser has no storage at all", () => {
    expect(loadAskDraft("local:s1", "ask-1", undefined)).toEqual({});
    expect(() => { saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, undefined); }).not.toThrow();
    expect(() => { clearAskDraft("local:s1", "ask-1", undefined); }).not.toThrow();
  });
});

describe("ask answer state", () => {
  it("counts and names answers exactly as the submission reports them", () => {
    const answers: AskDraftAnswers = { q1: { values: ["pg"] }, q3: { values: [], otherText: "  ship it  " } };

    expect(answeredCount(questions, answers)).toBe(2);
    expect(unansweredQuestions(questions, answers).map((question) => question.id)).toEqual(["q2"]);
    expect(toSubmission(questions, answers)).toEqual({
      answers: [{ id: "q1", values: ["pg"] }, { id: "q3", values: [], otherText: "ship it" }],
    });
  });

  it("treats untouched, empty, and whitespace-only answers as unanswered", () => {
    const answers: AskDraftAnswers = { q1: { values: [] }, q3: { values: [], otherText: "   " } };

    expect(answeredCount(questions, answers)).toBe(0);
    expect(unansweredQuestions(questions, answers).map((question) => question.id)).toEqual(["q1", "q2", "q3"]);
    expect(toSubmission(questions, answers)).toEqual({ answers: [] });
  });

  it("submits answers in the order the questions were asked", () => {
    const answers: AskDraftAnswers = { q3: { values: [], otherText: "later" }, q1: { values: ["sqlite"] } };

    expect(toSubmission(questions, answers).answers.map((answer) => answer.id)).toEqual(["q1", "q3"]);
  });

  it("keeps several values and custom text together for a multi-select question", () => {
    const answers: AskDraftAnswers = { q2: { values: ["metrics", "tracing"], otherText: "profiling" } };

    expect(toSubmission(questions, answers)).toEqual({
      answers: [{ id: "q2", values: ["metrics", "tracing"], otherText: "profiling" }],
    });
  });

  it("drops draft entries the question would reject rather than losing the whole submission", () => {
    // Drafts are browser-local and survive a superseding ask, another tab, or an
    // older app version, so an entry that no longer fits its question is
    // narrowed instead of poisoning every other answer.
    const answers: AskDraftAnswers = {
      q1: { values: ["mysql", "pg", "pg"], otherText: "custom" },
      q2: { values: ["metrics", "mongo"] },
      q3: { values: ["nope"], otherText: "note" },
    };

    expect(toSubmission(questions, answers)).toEqual({
      answers: [
        { id: "q1", values: ["pg"] },
        { id: "q2", values: ["metrics"] },
        { id: "q3", values: [], otherText: "note" },
      ],
    });
  });

  it("keeps custom text for every single-select question when no option is selected", () => {
    expect(toSubmission([singleSelect], { q1: { values: [], otherText: "neither" } })).toEqual({
      answers: [{ id: "q1", values: [], otherText: "neither" }],
    });
  });

  it("bounds custom text at the shared limit", () => {
    const answers: AskDraftAnswers = { q3: { values: [], otherText: "a".repeat(ASK_USER_OTHER_TEXT_MAX_LENGTH + 10) } };

    expect(toSubmission(questions, answers).answers[0]?.otherText).toHaveLength(ASK_USER_OTHER_TEXT_MAX_LENGTH);
  });
});
