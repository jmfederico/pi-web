// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthDialogState } from "../appState";
import type { AuthProviderOption, OAuthFlowState } from "../api";
import { AuthDialog, isBrowserRemoteOAuthMachine, isLoopbackHostname, oauthPromptInputType } from "./AuthDialog";
import { pressNativeButtonEnter } from "./modalSurfaceTestSupport";
import type { ModalSurface } from "./ModalSurface";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("oauthPromptInputType", () => {
  it("renders secret prompts as password inputs and other prompt types as text", () => {
    expect(oauthPromptInputType("secret")).toBe("password");
    expect(oauthPromptInputType("text")).toBe("text");
    expect(oauthPromptInputType("manual_code")).toBe("text");
  });
});

describe("isLoopbackHostname", () => {
  it("treats loopback names as local, case-insensitively and with bracketed IPv6", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("treats every other hostname as remote", () => {
    expect(isLoopbackHostname("pi.example.com")).toBe(false);
    expect(isLoopbackHostname("192.168.1.20")).toBe(false);
    expect(isLoopbackHostname("10.0.0.5")).toBe(false);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
    expect(isLoopbackHostname("my-localhost")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("isBrowserRemoteOAuthMachine", () => {
  it("is remote whenever the flow runs on a federated machine", () => {
    expect(isBrowserRemoteOAuthMachine("fleet-a", "localhost")).toBe(true);
    expect(isBrowserRemoteOAuthMachine("fleet-a", "pi.example.com")).toBe(true);
  });

  it("is remote for the local machine when the page host is not loopback", () => {
    expect(isBrowserRemoteOAuthMachine("local", "pi.example.com")).toBe(true);
    expect(isBrowserRemoteOAuthMachine("local", "10.0.0.5")).toBe(true);
    expect(isBrowserRemoteOAuthMachine("local", "")).toBe(true);
  });

  it("is local only for the local machine on a loopback page host", () => {
    expect(isBrowserRemoteOAuthMachine("local", "localhost")).toBe(false);
    expect(isBrowserRemoteOAuthMachine("local", "127.0.0.1")).toBe(false);
    expect(isBrowserRemoteOAuthMachine("local", "::1")).toBe(false);
  });
});

describe("auth-dialog focus on open", () => {
  it("focuses the dialog section when opened on the method step", async () => {
    const dialog = await mountDialog({ step: "method", machineId: "local" });

    expect(deepActiveElement()).toBe(dialogSection(dialog));
    expect(dialogSection(dialog).getAttribute("aria-label")).toBe("Configure provider authentication");
  });

  it("focuses the search box when opened on the providers step", async () => {
    const dialog = await mountDialog({ step: "providers", mode: "login", machineId: "local", providers: [providerOption("p1", "One")] });

    expect(deepActiveElement()).toBe(searchInput(dialog));
  });

  it("focuses the search box when opened on the logout step", async () => {
    const dialog = await mountDialog({ step: "logout", machineId: "local", providers: [providerOption("p1", "One")] });

    expect(deepActiveElement()).toBe(searchInput(dialog));
  });

  it("focuses the prompt input when opened directly on an OAuth prompt", async () => {
    const dialog = await mountDialog(oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } }));

    expect(deepActiveElement()).toBe(promptInput(dialog));
  });

  it("focuses the prompt input when a prompt appears after opening", async () => {
    const dialog = await mountDialog(oauthState());
    expect(deepActiveElement()).toBe(dialogSection(dialog));

    dialog.state = oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } });
    await settleDialog(dialog);

    expect(deepActiveElement()).toBe(promptInput(dialog));
  });

  it("moves focus back into the dialog when a step change replaces the focused control", async () => {
    const onChooseMethod = vi.fn<(authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog({ step: "method", machineId: "local" }, { onChooseMethod });
    const firstOption = requiredElement(optionButtons(dialog)[0], "first method option");
    firstOption.focus();
    pressNativeButtonEnter(firstOption);
    expect(onChooseMethod).toHaveBeenCalledWith("oauth");

    // The host app answers the method choice by advancing the dialog to the
    // providers step, replacing the button that held focus.
    dialog.state = { step: "providers", mode: "login", machineId: "local", authType: "oauth", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] };
    await settleDialog(dialog);

    expect(deepActiveElement()).toBe(searchInput(dialog));
    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(1);
  });

  it("returns focus to the dialog when an OAuth prompt disappears and keeps the next Tab inside", async () => {
    const dialog = await mountDialog(oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } }));
    expect(deepActiveElement()).toBe(promptInput(dialog));

    dialog.state = oauthState();
    await settleDialog(dialog);

    expect(deepActiveElement()).toBe(dialogSection(dialog));
    const tabEvent = pressKey(dialogSurface(dialog), "Tab");
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(deepActiveElement()).toBe(closeButton(dialog));
  });

  it("refocuses when OAuth selection and waiting controls replace each other", async () => {
    const onOAuthCancel = vi.fn<() => void>();
    const dialog = await mountDialog(
      oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } }),
      { onOAuthCancel },
    );

    dialog.state = oauthState({ select: oauthSelect("select-1", "Account one") });
    await settleDialog(dialog);
    expect(deepActiveElement()).toBe(dialogSection(dialog));

    requiredElement(oauthSelectButtons(dialog)[0], "first OAuth selection").focus();
    dialog.state = oauthState();
    await settleDialog(dialog);
    expect(deepActiveElement()).toBe(dialogSection(dialog));

    oauthActionButton(dialog, "Cancel").focus();
    dialog.state = oauthState({ select: oauthSelect("select-2", "Account two") });
    await settleDialog(dialog);
    expect(deepActiveElement()).toBe(dialogSection(dialog));

    pressKey(dialogSurface(dialog), "Escape");
    expect(onOAuthCancel).toHaveBeenCalledOnce();
  });

  it("returns focus to the prompt when the focused Submit button becomes disabled", async () => {
    const onOAuthCancel = vi.fn<() => void>();
    const prompt = { requestId: "req-1", message: "Enter the code", promptType: "text" } as const;
    const dialog = await mountDialog(oauthState({ prompt }), { onOAuthCancel });
    oauthActionButton(dialog, "Submit").focus();

    dialog.state = { ...oauthState({ prompt }), responding: true };
    await settleDialog(dialog);

    expect(oauthActionButton(dialog, "Submit").disabled).toBe(true);
    expect(deepActiveElement()).toBe(promptInput(dialog));
    pressKey(promptInput(dialog), "Escape");
    expect(onOAuthCancel).toHaveBeenCalledOnce();
  });
});

describe("auth-dialog Escape", () => {
  it("cancels the dialog on Escape from an option-list step", async () => {
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog({ step: "method", machineId: "local" }, { onCancel });

    pressKey(dialogSurface(dialog), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels the OAuth flow on Escape from the oauth step", async () => {
    const onOAuthCancel = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog(oauthState(), { onOAuthCancel, onCancel });

    pressKey(dialogSurface(dialog), "Escape");

    expect(onOAuthCancel).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("auth-dialog option-list keyboard navigation", () => {
  it("moves the selection with ArrowDown and ArrowUp, wrapping at both ends", async () => {
    const dialog = await mountDialog({ step: "providers", mode: "login", machineId: "local", providers: [providerOption("p1", "One"), providerOption("p2", "Two"), providerOption("p3", "Three")] });
    expect(selectedOptionIndex(dialog)).toBe(0);

    // happy-dom does not propagate events out of shadow roots, so key presses
    // that would bubble from the dialog section to the modal-surface host in a
    // browser are dispatched on the host itself (see ModalSurface.test.ts).
    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(1);

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(2);

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(0);

    pressKey(dialogSurface(dialog), "ArrowUp");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(2);
  });

  it("activates the selected login method with Enter", async () => {
    const onChooseMethod = vi.fn<(authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog({ step: "method", machineId: "local" }, { onChooseMethod });

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    const event = pressKey(dialogSurface(dialog), "Enter");

    expect(onChooseMethod).toHaveBeenCalledWith("api_key");
    expect(event.defaultPrevented).toBe(true);
  });

  it("activates the selected provider with Enter", async () => {
    const onSelectProvider = vi.fn<(providerId: string, authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog(
      { step: "providers", mode: "login", machineId: "local", authType: "oauth", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] },
      { onSelectProvider },
    );

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    pressKey(dialogSurface(dialog), "Enter");

    expect(onSelectProvider).toHaveBeenCalledWith("p2", "oauth");
  });

  it("lets a focused option own Enter and exposes that option as current", async () => {
    const onSelectProvider = vi.fn<(providerId: string, authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog(
      { step: "providers", mode: "login", machineId: "local", authType: "oauth", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] },
      { onSelectProvider },
    );
    const secondOption = requiredElement(optionButtons(dialog)[1], "second provider option");

    expect(selectedOptionIndex(dialog)).toBe(0);
    secondOption.focus();
    await settleDialog(dialog);

    expect(selectedOptionIndex(dialog)).toBe(1);
    expect(secondOption.getAttribute("aria-current")).toBe("true");
    const event = pressNativeButtonEnter(secondOption);

    expect(event.defaultPrevented).toBe(false);
    expect(onSelectProvider).toHaveBeenCalledOnce();
    expect(onSelectProvider).toHaveBeenCalledWith("p2", "oauth");
  });

  it("activates the selected stored credential with Enter on the logout step", async () => {
    const onLogoutProvider = vi.fn<(providerId: string) => void>();
    const dialog = await mountDialog({ step: "logout", machineId: "local", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] }, { onLogoutProvider });

    pressKey(dialogSurface(dialog), "Enter");

    expect(onLogoutProvider).toHaveBeenCalledWith("p1");
  });

  it("does not log out the selected provider when Enter belongs to another focused button", async () => {
    const onLogoutProvider = vi.fn<(providerId: string) => void>();
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog(
      { step: "logout", machineId: "local", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] },
      { onLogoutProvider, onCancel },
    );
    const secondProvider = requiredElement(optionButtons(dialog)[1], "second logout provider");

    secondProvider.focus();
    await settleDialog(dialog);
    pressNativeButtonEnter(secondProvider);
    expect(onLogoutProvider).toHaveBeenCalledWith("p2");

    closeButton(dialog).focus();
    const closeEvent = pressNativeButtonEnter(closeButton(dialog));

    expect(closeEvent.defaultPrevented).toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onLogoutProvider).toHaveBeenCalledTimes(1);
  });

  it("restarts the selection at the first option when the step changes", async () => {
    const dialog = await mountDialog({ step: "providers", mode: "login", machineId: "local", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] });
    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(1);

    dialog.state = { step: "logout", machineId: "local", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] };
    await settleDialog(dialog);

    expect(selectedOptionIndex(dialog)).toBe(0);
  });
});

describe("auth-dialog provider search", () => {
  it("filters providers by name and id as the query narrows the list", async () => {
    const dialog = await mountDialog({
      step: "providers", mode: "login", machineId: "local",
      providers: [providerOption("anthropic", "Anthropic"), providerOption("openai", "OpenAI"), providerOption("github-copilot", "GitHub Copilot")],
    });
    expect(optionButtons(dialog)).toHaveLength(3);

    await typeIntoSearch(dialog, "a");
    expect(optionButtons(dialog)).toHaveLength(2);
    expect(requiredElement(optionButtons(dialog)[0], "first filtered provider").textContent).toContain("Anthropic");
    expect(requiredElement(optionButtons(dialog)[1], "second filtered provider").textContent).toContain("OpenAI");

    await typeIntoSearch(dialog, "cop");
    expect(optionButtons(dialog)).toHaveLength(1);
    expect(requiredElement(optionButtons(dialog)[0], "only matching provider").textContent).toContain("GitHub Copilot");
  });

  it("activates the filtered provider with Enter from the search box", async () => {
    const onSelectProvider = vi.fn<(providerId: string, authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog(
      { step: "providers", mode: "login", machineId: "local", authType: "oauth", providers: [providerOption("anthropic", "Anthropic"), providerOption("openai", "OpenAI")] },
      { onSelectProvider },
    );

    await typeIntoSearch(dialog, "openai");
    pressKey(dialogSurface(dialog), "Enter");

    expect(onSelectProvider).toHaveBeenCalledWith("openai", "oauth");
  });

  it("moves the roving selection within the filtered list", async () => {
    const dialog = await mountDialog({
      step: "providers", mode: "login", machineId: "local",
      providers: [providerOption("anthropic", "Anthropic"), providerOption("openai", "OpenAI")],
    });

    await typeIntoSearch(dialog, "a");
    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(1);
  });

  it("shows a no-match message when the query matches no provider", async () => {
    const dialog = await mountDialog({
      step: "providers", mode: "login", machineId: "local",
      providers: [providerOption("anthropic", "Anthropic"), providerOption("openai", "OpenAI")],
    });

    await typeIntoSearch(dialog, "zzz");
    expect(optionButtons(dialog)).toHaveLength(0);
    expect(dialog.shadowRoot?.textContent).toContain("No matching providers");
  });

  it("hides the search box when no providers are available", async () => {
    const dialog = await mountDialog({ step: "providers", mode: "login", machineId: "local", providers: [] });

    expect(dialog.shadowRoot?.querySelector("input")).toBeNull();
    expect(dialog.shadowRoot?.textContent).toContain("No providers available.");
  });

  it("resets the search query when the step changes", async () => {
    const dialog = await mountDialog({
      step: "providers", mode: "login", machineId: "local",
      providers: [providerOption("p1", "One"), providerOption("p2", "Two")],
    });

    await typeIntoSearch(dialog, "one");
    expect(optionButtons(dialog)).toHaveLength(1);

    dialog.state = { step: "logout", machineId: "local", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] };
    await settleDialog(dialog);

    expect(searchInput(dialog).value).toBe("");
    expect(optionButtons(dialog)).toHaveLength(2);
  });

  it("filters stored credentials on the logout step", async () => {
    const onLogoutProvider = vi.fn<(providerId: string) => void>();
    const dialog = await mountDialog(
      { step: "logout", machineId: "local", providers: [providerOption("anthropic", "Anthropic"), providerOption("openai", "OpenAI")] },
      { onLogoutProvider },
    );

    await typeIntoSearch(dialog, "openai");
    expect(optionButtons(dialog)).toHaveLength(1);
    pressKey(dialogSurface(dialog), "Enter");
    expect(onLogoutProvider).toHaveBeenCalledWith("openai");
  });
});

describe("auth-dialog OAuth prompt keys", () => {
  it("submits the OAuth prompt with Enter", async () => {
    const onOAuthRespond = vi.fn<(value?: string) => void>();
    const dialog = await mountDialog(oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } }), { onOAuthRespond });

    pressKey(promptInput(dialog), "Enter");

    expect(onOAuthRespond).toHaveBeenCalledOnce();
  });

  it("lets a focused OAuth Cancel button own Enter instead of submitting", async () => {
    const onOAuthRespond = vi.fn<(value?: string) => void>();
    const onOAuthCancel = vi.fn<() => void>();
    const dialog = await mountDialog(
      oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } }),
      { onOAuthRespond, onOAuthCancel },
    );
    const cancel = oauthActionButton(dialog, "Cancel");
    cancel.focus();

    const event = pressNativeButtonEnter(cancel);

    expect(event.defaultPrevented).toBe(false);
    expect(onOAuthCancel).toHaveBeenCalledOnce();
    expect(onOAuthRespond).not.toHaveBeenCalled();
  });

  it("lets a focused OAuth authorization link own Enter instead of submitting", async () => {
    const onOAuthRespond = vi.fn<(value?: string) => void>();
    const dialog = await mountDialog(
      oauthState({
        auth: { url: "https://auth.example.test/login" },
        prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" },
      }),
      { onOAuthRespond },
    );
    const link = oauthAuthorizationLink(dialog);
    link.focus();

    const event = pressKey(link, "Enter");

    expect(event.defaultPrevented).toBe(false);
    expect(onOAuthRespond).not.toHaveBeenCalled();
  });
});

interface AuthDialogCallbacks {
  onChooseMethod?: (authType: "oauth" | "api_key") => void;
  onSelectProvider?: (providerId: string, authType: "oauth" | "api_key") => void;
  onLogoutProvider?: (providerId: string) => void;
  onOAuthInput?: (value: string) => void;
  onOAuthRespond?: (value?: string) => void;
  onOAuthCancel?: () => void;
  onCancel?: () => void;
}

async function mountDialog(state: AuthDialogState, callbacks: AuthDialogCallbacks = {}): Promise<AuthDialog> {
  const dialog = new AuthDialog();
  Object.assign(dialog, callbacks);
  dialog.state = state;
  document.body.append(dialog);
  await settleDialog(dialog);
  return dialog;
}

async function settleDialog(dialog: AuthDialog): Promise<void> {
  // Await the dialog, the nested modal-surface it renders, and one more dialog
  // cycle so any render scheduled from within updated() has settled.
  await dialog.updateComplete;
  await dialogSurface(dialog).updateComplete;
  await dialog.updateComplete;
}

function dialogSurface(dialog: AuthDialog): ModalSurface {
  return requiredElement(dialog.shadowRoot?.querySelector<ModalSurface>("modal-surface"), "auth-dialog modal-surface");
}

function dialogSection(dialog: AuthDialog): HTMLElement {
  return requiredElement(dialogSurface(dialog).shadowRoot?.querySelector("section[role='dialog']"), "auth-dialog dialog section");
}

function promptInput(dialog: AuthDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector("input"), "OAuth prompt input");
}

function searchInput(dialog: AuthDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLInputElement>("input[placeholder='Search providers']"), "provider search input");
}

async function typeIntoSearch(dialog: AuthDialog, value: string): Promise<void> {
  const input = searchInput(dialog);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settleDialog(dialog);
}

function closeButton(dialog: AuthDialog): HTMLButtonElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("header button[aria-label='Close']"), "auth-dialog Close button");
}

function optionButtons(dialog: AuthDialog): HTMLButtonElement[] {
  return [...(dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options button") ?? [])];
}

function oauthSelectButtons(dialog: AuthDialog): HTMLButtonElement[] {
  return [...(dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>(".inline-options button") ?? [])];
}

function oauthAuthorizationLink(dialog: AuthDialog): HTMLAnchorElement {
  return requiredElement(dialog.shadowRoot?.querySelector<HTMLAnchorElement>(".form a[href]"), "OAuth authorization link");
}

function oauthActionButton(dialog: AuthDialog, label: string): HTMLButtonElement {
  const button = [...(dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button") ?? [])]
    .find((candidate) => candidate.textContent.trim() === label);
  return requiredElement(button, `OAuth ${label} button`);
}

function selectedOptionIndex(dialog: AuthDialog): number {
  return optionButtons(dialog).findIndex((button) => button.classList.contains("selected"));
}

function providerOption(id: string, name: string): AuthProviderOption {
  return { id, name, authType: "oauth", status: { configured: false } };
}

function oauthState(flow: Partial<OAuthFlowState> = {}): Extract<AuthDialogState, { step: "oauth" }> {
  return {
    step: "oauth",
    machineId: "machine-1",
    flow: { flowId: "flow-1", providerId: "anthropic", providerName: "Anthropic", status: "running", progress: [], ...flow },
  };
}

function oauthSelect(requestId: string, label: string): NonNullable<OAuthFlowState["select"]> {
  return { requestId, message: "Choose an account", options: [{ value: requestId, label }] };
}

function pressKey(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement instanceof Element) {
    active = active.shadowRoot.activeElement;
  }
  // happy-dom reports activeElement as undefined when nothing is focused;
  // the runtime value is normalized even though the type says Element | null.
  return active ?? null;
}

function requiredElement<T extends Element>(element: T | null | undefined, description: string): T {
  if (element === null || element === undefined) throw new Error(`Expected ${description} to exist`);
  return element;
}
