// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../api";
import { SessionList } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
});

describe("session-list new session backend chooser", () => {
  it("starts new sessions with Pi by default and with the chosen backend after selecting it, without touching other session callbacks", async () => {
    const list = new SessionList();
    list.canStart = true;
    const started: unknown[] = [];
    const selected: string[] = [];
    const archived: string[] = [];
    list.onStart = (backend) => { started.push(backend); };
    list.onSelect = (session: SessionInfo) => { selected.push(session.id); };
    list.onArchive = (session: SessionInfo) => { archived.push(session.id); };
    document.body.appendChild(list);
    await list.updateComplete;

    startButton(list).click();
    expect(started).toEqual(["pi"]);

    const select = backendSelect(list);
    expect(select.value).toBe("pi");
    select.value = "omp";
    select.dispatchEvent(new Event("change"));
    await list.updateComplete;

    // Choosing a backend is inert on its own: it must never reach out and
    // mutate an already-selected or already-archived session's engine.
    expect(selected).toEqual([]);
    expect(archived).toEqual([]);

    startButton(list).click();
    expect(started).toEqual(["pi", "omp"]);
  });

  it("gives the OMP option its own accessible hint distinct from Pi's, without prescribing exact wording", async () => {
    const list = new SessionList();
    list.canStart = true;
    document.body.appendChild(list);
    await list.updateComplete;

    const options = [...(list.shadowRoot?.querySelectorAll(".new-session-backend option") ?? [])];
    const piOption = options.find((option) => option instanceof HTMLOptionElement && option.value === "pi");
    const ompOption = options.find((option) => option instanceof HTMLOptionElement && option.value === "omp");
    if (!(piOption instanceof HTMLOptionElement) || !(ompOption instanceof HTMLOptionElement)) throw new Error("Expected Pi and OMP backend options");

    // This hint is the only inline warning that OMP uses machine-owned
    // credentials/configuration rather than the browser's Pi account. Keep
    // that distinction semantic while leaving the exact copy unconstrained.
    expect(ompOption.title).toMatch(/\bomp\b/i);
    expect(ompOption.title).toMatch(/login|config|settings/i);
    expect(ompOption.title).toMatch(/(?:not|without|separate|instead of|rather than)[^.!]*\bpi\b|\bpi\b[^.!]*(?:not|without|separate|instead of|rather than)/i);
  });
});

function requiredElement(root: ParentNode | null | undefined, selector: string): Element {
  const element = root?.querySelector(selector);
  if (element === null || element === undefined) throw new Error(`Expected ${selector}`);
  return element;
}

function startButton(list: SessionList): HTMLButtonElement {
  const element = requiredElement(list.shadowRoot, ".start-session-button");
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected the start-session button");
  return element;
}

function backendSelect(list: SessionList): HTMLSelectElement {
  const element = requiredElement(list.shadowRoot, ".new-session-backend");
  if (!(element instanceof HTMLSelectElement)) throw new Error("Expected the new-session backend select");
  return element;
}
