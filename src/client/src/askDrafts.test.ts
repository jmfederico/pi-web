import { afterEach, describe, expect, it } from "vitest";
import { ASK_USER_COMMENT_MAX_LENGTH, ASK_USER_OTHER_TEXT_MAX_LENGTH, type AskUserQuestion } from "../../shared/apiTypes";
import {
  answeredCount, clearAskDraft, isCommentOpen, isCustomAnswerSelected, loadAskDraft, saveAskDraft,
  toSubmission, unansweredQuestions, type AskDraftAnswers,
} from "./askDrafts";

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

    saveAskDraft("local:s1", "ask-1", { q1: { values: [] } }, storage);

    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1")).toBeNull();
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});
  });

  it("keeps a comment in the draft, with or without a selection beside it", () => {
    const storage = new MemoryStorage();
    const answers: AskDraftAnswers = {
      q1: { values: ["pg"], comment: "we already run a cluster" },
      q2: { values: [], comment: "still deciding" },
    };

    saveAskDraft("local:s1", "ask-1", answers, storage);

    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual(answers);
  });

  it("retains dormant buffers, active empty fields, and independent false flags on reload", () => {
    const storage = new MemoryStorage();
    const answers: AskDraftAnswers = {
      dormant: { values: [], otherText: "saved custom", comment: "saved comment", customSelected: false, commentOpen: false },
      custom: { values: [], otherText: "", customSelected: true, commentOpen: false },
      comment: { values: [], comment: "", customSelected: false, commentOpen: true },
      flagsOnly: { values: [], customSelected: false, commentOpen: false },
      activeFlagsOnly: { values: [], customSelected: true, commentOpen: true },
      legacyEmpty: { values: [], otherText: "", comment: "" },
    };

    saveAskDraft("local:s1", "ask-1", answers, storage);

    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual(answers);
  });

  it.each(["customSelected", "commentOpen"])("rejects nonboolean %s flags", (flag) => {
    const storage = new MemoryStorage();
    for (const invalid of [null, 0, 1, "false", [], {}]) {
      storage.setItem("pi-web:ask-draft:local:s1:ask-1", JSON.stringify({
        invalid: { values: ["pg"], [flag]: invalid },
        valid: { values: ["metrics"], customSelected: false, commentOpen: true },
      }));

      expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({
        valid: { values: ["metrics"], customSelected: false, commentOpen: true },
      });
    }
  });

  it("drops a draft entry whose comment is not text", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "pi-web:ask-draft:local:s1:ask-1",
      JSON.stringify({ q1: { values: ["pg"], comment: 7 }, q2: { values: ["metrics"], comment: "only in staging" } }),
    );

    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({ q2: { values: ["metrics"], comment: "only in staging" } });
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

describe("ask draft visibility", () => {
  it("infers legacy Custom selection while respecting explicit flags and optionless questions", () => {
    expect(isCustomAnswerSelected(singleSelect, undefined)).toBe(false);
    expect(isCustomAnswerSelected(freeTextOnly, undefined)).toBe(true);
    expect(isCustomAnswerSelected(singleSelect, { values: [], otherText: "" })).toBe(true);
    expect(isCustomAnswerSelected(singleSelect, { values: ["pg"], otherText: "saved" })).toBe(false);
    expect(isCustomAnswerSelected(multiSelect, { values: ["metrics"], otherText: "" })).toBe(true);
    expect(isCustomAnswerSelected(singleSelect, { values: [], customSelected: true })).toBe(true);
    expect(isCustomAnswerSelected(multiSelect, { values: [], otherText: "saved", customSelected: false })).toBe(false);
    expect(isCustomAnswerSelected(freeTextOnly, { values: [], customSelected: false })).toBe(true);
  });

  it("uses comment visibility independently of its buffer and Custom selection", () => {
    expect(isCommentOpen(undefined)).toBe(false);
    expect(isCommentOpen({ values: [], comment: "" })).toBe(true);
    expect(isCommentOpen({ values: [], comment: "saved", commentOpen: false })).toBe(false);
    expect(isCommentOpen({ values: [], customSelected: true, commentOpen: true })).toBe(true);
  });
});

describe("ask answer state", () => {
  it("excludes inactive buffers while allowing an open comment beside offered selections", () => {
    const answers: AskDraftAnswers = {
      q1: { values: ["pg"], otherText: "dormant", customSelected: false, comment: "hidden", commentOpen: false },
      q2: { values: ["metrics"], otherText: "dormant", customSelected: false, comment: "  visible  ", commentOpen: true },
    };

    expect(toSubmission(questions, answers)).toEqual({ answers: [
      { id: "q1", values: ["pg"] },
      { id: "q2", values: ["metrics"], comment: "visible" },
    ] });
  });

  it.each(["", "   "])("keeps blank explicit Custom unanswered and hides its comment (%j)", (otherText) => {
    const answers: AskDraftAnswers = {
      q1: { values: ["pg"], otherText, customSelected: true, comment: "hidden", commentOpen: true },
      q2: { values: [], otherText: "dormant", customSelected: false, comment: "not an answer", commentOpen: true },
      q3: { values: [], otherText, comment: "hidden", commentOpen: true },
    };

    expect(toSubmission(questions, answers)).toEqual({ answers: [] });
    expect(answeredCount(questions, answers)).toBe(0);
    expect(unansweredQuestions(questions, answers)).toEqual(questions);

    answers["q2"] = { ...answers["q2"], values: ["metrics"] };
    expect(toSubmission(questions, answers)).toEqual({ answers: [
      { id: "q2", values: ["metrics"], comment: "not an answer" },
    ] });
    expect(answeredCount(questions, answers)).toBe(1);
    expect(unansweredQuestions(questions, answers)).toEqual([singleSelect, freeTextOnly]);
  });

  it("lets explicit Custom override single selections but combine with multiple selections", () => {
    const answers: AskDraftAnswers = {
      q1: { values: ["pg", "sqlite"], customSelected: true, otherText: "  custom db  ", commentOpen: true, comment: "hidden" },
      q2: { values: ["metrics", "removed", "metrics"], customSelected: true, otherText: "profiling", commentOpen: true, comment: "hidden" },
    };

    expect(toSubmission(questions, answers)).toEqual({ answers: [
      { id: "q1", values: [], otherText: "custom db" },
      { id: "q2", values: ["metrics"], otherText: "profiling" },
    ] });
    expect(answeredCount(questions, answers)).toBe(2);
    expect(unansweredQuestions(questions, answers)).toEqual([freeTextOnly]);
  });
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

  it("submits a comment alongside the answer it accompanies", () => {
    const answers: AskDraftAnswers = {
      q1: { values: ["pg"], comment: "  the cluster is already provisioned  " },
      q2: { values: ["metrics"], otherText: "profiling", comment: "staging first" },
    };

    expect(answeredCount(questions, answers)).toBe(2);
    expect(toSubmission(questions, answers)).toEqual({
      answers: [
        { id: "q1", values: ["pg"], comment: "the cluster is already provisioned" },
        { id: "q2", values: ["metrics"], otherText: "profiling" },
      ],
    });
  });

  it("keeps a comment when offered selections are narrowed to fit the question", () => {
    const answers: AskDraftAnswers = { q1: { values: ["mysql", "pg"], comment: "whatever ops prefer" } };

    expect(toSubmission(questions, answers)).toEqual({
      answers: [{ id: "q1", values: ["pg"], comment: "whatever ops prefer" }],
    });
  });

  it.each(["custom", "", "   "])("prioritizes legacy single selections and hides comments only for active Custom (%j)", (otherText) => {
    const answers: AskDraftAnswers = {
      q1: { values: ["mysql", "pg"], otherText, comment: "hidden single comment" },
      q2: { values: ["metrics", "tracing"], otherText, comment: "hidden multi comment" },
      q3: { values: [], otherText: "note", comment: "hidden optionless comment" },
    };

    expect(toSubmission(questions, answers)).toEqual({
      answers: [
        { id: "q1", values: ["pg"], comment: "hidden single comment" },
        { id: "q2", values: ["metrics", "tracing"], ...(otherText.trim() === "" ? {} : { otherText }) },
        { id: "q3", values: [], otherText: "note" },
      ],
    });
  });

  it("drops stale comments without a valid offered selection", () => {
    expect(toSubmission(questions, {
      q1: { values: ["removed"], comment: "stale selection" },
      q2: { values: [], otherText: "profiling", comment: "custom only" },
      q3: { values: ["removed"], comment: "no options" },
    })).toEqual({ answers: [{ id: "q2", values: [], otherText: "profiling" }] });
  });

  it("leaves a question unanswered when a comment is all the user typed", () => {
    // "Answered" stays a statement about what the user chose, so a comment on its
    // own is retained locally for the next reload but never submitted as an answer.
    const answers: AskDraftAnswers = { q1: { values: [], comment: "no preference" } };
    const storage = new MemoryStorage();

    expect(answeredCount(questions, answers)).toBe(0);
    expect(unansweredQuestions(questions, answers).map((question) => question.id)).toEqual(["q1", "q2", "q3"]);
    expect(toSubmission(questions, answers)).toEqual({ answers: [] });

    saveAskDraft("local:s1", "ask-1", answers, storage);
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual(answers);
  });

  it("bounds a comment at the shared limit", () => {
    const answers: AskDraftAnswers = { q1: { values: ["pg"], comment: "c".repeat(ASK_USER_COMMENT_MAX_LENGTH + 10) } };

    expect(toSubmission(questions, answers).answers[0]?.comment).toHaveLength(ASK_USER_COMMENT_MAX_LENGTH);
  });
});
