// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { localization } from "../localization/browser";
import { extensionDialogMessages } from "../extensionDialogMessages";
import { ExtensionDialogCard, extensionDialogCloseLabel, extensionDialogCloseSummary, extensionDialogCountdownText } from "./ExtensionDialogCard";
import type { PendingExtensionDialog, ExtensionDialogCloseReason } from "../../../shared/apiTypes";

let release: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  release?.();
  release = undefined;
  await localization.setPreferences({ language: "en", formatLocale: "en" });
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

const dialog: PendingExtensionDialog = {
  dialogId: "dialog-id", kind: "input", title: "User <b>title</b> العربية", placeholder: "Unchanged placeholder",
  askedAt: "2026-07-27T10:00:00Z", runScoped: false,
};

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected extension dialog element");
  return value;
}
async function mount(value = dialog): Promise<ExtensionDialogCard> {
  const card = new ExtensionDialogCard();
  card.dialog = value;
  document.body.append(card);
  await card.updateComplete;
  return card;
}
async function language(card: ExtensionDialogCard, language: string): Promise<void> {
  await localization.setPreferences({ language, formatLocale: "ar-EG" });
  await card.updateComplete;
}

it("keeps input identity, focus and draft across live catalog/pseudo changes, then submits the raw answer", async () => {
  release = localization.registerCatalog({ id: "dialog-test", namespace: "core.extensionDialogs", locale: "de", load: () => Promise.resolve({
    yourAnswer: "Deine Antwort", send: "Senden", cancel: "Abbrechen",
  }) });
  const card = await mount();
  const answer = vi.fn();
  const cancel = vi.fn();
  card.onAnswer = answer;
  card.onCancel = cancel;
  const root = required(card.shadowRoot);
  const input = required(root.querySelector("input"));
  input.value = "Raw <img> العربية";
  input.dispatchEvent(new Event("input"));
  await card.updateComplete;
  input.focus();
  for (const locale of ["de", "en-XA", "ar-XB"]) {
    await language(card, locale);
    expect(root.querySelector("input")).toBe(input);
    expect(root.activeElement).toBe(input);
    expect(input.value).toBe("Raw <img> العربية");
    expect(input.placeholder).toBe(dialog.placeholder);
    expect(input.getAttribute("aria-label")).toBe(extensionDialogMessages.t("yourAnswer"));
    expect(root.querySelector("h2")?.textContent).toBe(dialog.title);
    expect(root.querySelector("h2")?.getAttribute("dir")).toBe("auto");
    expect(root.querySelector("b, img")).toBeNull();
    expect(answer).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  }
  required(root.querySelector<HTMLButtonElement>("button[type=submit]")).click();
  await Promise.resolve();
  expect(answer).toHaveBeenCalledExactlyOnceWith("dialog-id", "Raw <img> العربية");
});

it("retains pending submission and restores controls after rejection without retransmitting on language changes", async () => {
  const card = await mount();
  let reject: ((reason: Error) => void) | undefined;
  const answer = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  card.onAnswer = answer;
  const root = required(card.shadowRoot);
  const send = required(root.querySelector<HTMLButtonElement>("button[type=submit]"));
  send.click();
  await Promise.resolve();
  await card.updateComplete;
  for (const locale of ["en-XA", "ar-XB"]) {
    await language(card, locale);
    expect(send.disabled).toBe(true);
    expect(send.textContent).toBe(extensionDialogMessages.t("sending"));
    expect(answer).toHaveBeenCalledExactlyOnceWith("dialog-id", "");
  }
  required(reject)(new Error("Raw transport diagnostic"));
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await card.updateComplete;
  expect(send.disabled).toBe(false);
  expect(send.textContent).toBe(extensionDialogMessages.t("send"));
});

it("updates confirm and choice controls but never translates extension-owned messages/options or boolean answers", async () => {
  const card = await mount({ ...dialog, kind: "confirm", message: "Yes <b>raw message</b>" });
  const answer = vi.fn();
  card.onAnswer = answer;
  const root = required(card.shadowRoot);
  await language(card, "ar-XB");
  expect(root.querySelector(".dialog-message")?.textContent).toBe("Yes <b>raw message</b>");
  required(root.querySelector<HTMLButtonElement>(".primary-action")).click();
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await card.updateComplete;
  expect(answer).toHaveBeenCalledExactlyOnceWith("dialog-id", true);
  card.dialog = { ...dialog, dialogId: "select-id", kind: "select", options: ["Yes", "Raw <img> العربية"] };
  await card.updateComplete;
  expect(root.querySelector(".dialog-options")?.getAttribute("aria-label")).toBe(extensionDialogMessages.t("choices"));
  const options = root.querySelectorAll<HTMLButtonElement>(".option-button");
  expect([...options].map((option) => option.textContent)).toEqual(["Yes", "Raw <img> العربية"]);
  required(options[1]).click();
  await Promise.resolve();
  expect(answer).toHaveBeenLastCalledWith("select-id", "Raw <img> العربية");
  expect(root.querySelector("img, b")).toBeNull();
});

it("keeps the countdown regional, display-only and on the same deadline across locales", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-07-27T10:00:00Z");
  vi.setSystemTime(now);
  const card = await mount({ ...dialog, timeoutAt: "2026-07-27T10:01:30Z" });
  const root = required(card.shadowRoot);
  const cancel = vi.fn();
  card.onCancel = cancel;
  await language(card, "en");
  const numeral = new Intl.NumberFormat("ar-EG").format(30);
  expect(root.querySelector(".countdown")?.textContent).toContain(numeral);
  await language(card, "ar-XB");
  expect(root.querySelector(".countdown")?.textContent).toBe(extensionDialogMessages.t("minutes", { minutes: 1, seconds: 30 }));
  await vi.advanceTimersByTimeAsync(90_000);
  await card.updateComplete;
  expect(root.querySelector(".countdown")?.textContent).toBe(extensionDialogMessages.t("imminent"));
  expect(root.querySelector("[aria-live]")).toBeNull();
  expect(root.querySelector(".countdown")?.getAttribute("role")).toBeNull();
  expect(cancel).not.toHaveBeenCalled();
  expect(extensionDialogCountdownText("2026-07-27T12:59:59Z", now)).toBe(extensionDialogMessages.t("hours", { hours: 2, minutes: 59 }));
  expect(extensionDialogCountdownText("2026-07-27T10:00:45Z", now)).toBe(extensionDialogMessages.t("seconds", { seconds: 45 }));
  card.remove();
  expect(vi.getTimerCount()).toBe(0);
});

it("localizes the dismissal countdown without restarting it", async () => {
  vi.useFakeTimers();
  const card = await mount();
  const dismiss = vi.fn();
  card.onDismiss = dismiss;
  card.outcome = { dialog, reason: "cancelled" };
  await card.updateComplete;
  await vi.advanceTimersByTimeAsync(2_000);
  await language(card, "ar-XB");
  const root = required(card.shadowRoot);
  expect(root.querySelector(".auto-dismiss span")?.textContent).toBe(extensionDialogMessages.t("autoDismiss", { seconds: 8 }));
  expect(root.querySelector(".auto-dismiss button")?.textContent).toBe(extensionDialogMessages.t("keepVisible"));
  expect(root.querySelector("[aria-live], [role=status]")).toBeNull();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(dismiss).toHaveBeenCalledExactlyOnceWith("dialog-id");
});

it("refreshes all settled reasons and summaries, preserving raw answers and dismiss identity", async () => {
  const card = await mount();
  const dismiss = vi.fn();
  card.onDismiss = dismiss;
  const root = required(card.shadowRoot);
  const reasons: ExtensionDialogCloseReason[] = ["answered", "cancelled", "timeout", "aborted", "session-ended"];
  for (const reason of reasons) {
    card.outcome = { dialog, reason, answer: "Yes <img> العربية" };
    await card.updateComplete;
    for (const locale of ["en", "en-XA", "ar-XB"]) {
      await language(card, locale);
      expect(root.querySelector(".header-status")?.textContent).toBe(extensionDialogCloseLabel(reason));
      expect(root.querySelector(".closed-summary")?.textContent).toBe(extensionDialogCloseSummary(card.outcome));
      expect(root.querySelector("h2")?.textContent).toBe(dialog.title);
      expect(root.querySelector("img")).toBeNull();
      expect(dismiss).not.toHaveBeenCalled();
      if (reason === "answered") {
        expect(root.textContent).not.toContain("Yes <img> العربية");
        const toggle = required(root.querySelector<HTMLButtonElement>(".answer-visibility"));
        expect(toggle.getAttribute("aria-label")).toBe(extensionDialogMessages.t("seeAnswer"));
        toggle.click();
        await card.updateComplete;
        expect(root.querySelector(".closed-summary")?.textContent).toBe(extensionDialogCloseSummary(card.outcome, true));
        expect(root.querySelector(".closed-summary")?.textContent).toContain("Yes <img> العربية");
        expect(root.querySelector("img")).toBeNull();
        expect(toggle.getAttribute("aria-label")).toBe(extensionDialogMessages.t("hideAnswer"));
        // A catalog change must not itself reveal or hide an answer.
        await language(card, locale === "en" ? "en-XA" : "en");
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(toggle.title).toBe(extensionDialogMessages.t("hideAnswer"));
        toggle.click();
        await card.updateComplete;
        expect(root.textContent).not.toContain("Yes <img> العربية");
      }
    }
  }
  for (const answer of [true, false, "", undefined]) {
    const closed = { dialog: { ...dialog, kind: typeof answer === "boolean" ? "confirm" as const : "input" as const }, reason: "answered" as const, ...(answer === undefined ? {} : { answer }) };
    const expected = answer === undefined ? extensionDialogMessages.t("missingAnswer")
      : answer === "" ? extensionDialogMessages.t("hiddenAnswer")
      : extensionDialogMessages.t("booleanAnswer", { answer: answer === true ? "yes" : "no" });
    expect(extensionDialogCloseSummary(closed)).toBe(expected);
    if (answer === "") expect(extensionDialogCloseSummary(closed, true)).toBe(extensionDialogMessages.t("emptyAnswer"));
  }
  required(root.querySelector<HTMLButtonElement>("button")).click();
  expect(dismiss).toHaveBeenCalledExactlyOnceWith("dialog-id");
});
