// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { OAuthFlowState } from "../api";
import type { AuthDialogState } from "../appState";
import { AuthDialog } from "./AuthDialog";

const PASTE_NOTE_MARKER = "Copy the full URL";
const MANUAL_CODE_PROMPT = {
  requestId: "req-1",
  message: "Paste the redirect URL here",
  placeholder: "http://localhost:53692/callback#...",
  promptType: "manual_code",
} as const;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("auth-dialog remote OAuth paste-first note", () => {
  it("shows the paste note when the flow runs on a federated machine, even from a loopback page", async () => {
    const flow = oauthFlow({ prompt: MANUAL_CODE_PROMPT });
    const dialog = await mountDialog(oauthState({ machineId: "fleet-a", flow }), "http://localhost:5173/");
    expect(dialogText(dialog)).toContain(PASTE_NOTE_MARKER);
    expect(dialogText(dialog)).toContain("Open this authorization link:");
  });

  it("shows the paste note when the local machine's gateway host is not loopback for the browser", async () => {
    const flow = oauthFlow({ prompt: MANUAL_CODE_PROMPT });
    const dialog = await mountDialog(oauthState({ flow }), "https://pi.example.com/");
    expect(dialogText(dialog)).toContain(PASTE_NOTE_MARKER);
  });

  it("waits for the manual-code prompt before promising a paste input", async () => {
    const dialog = await mountDialog(oauthState({ machineId: "fleet-a" }), "https://pi.example.com/");
    expect(dialogText(dialog)).not.toContain(PASTE_NOTE_MARKER);
    expect(dialogText(dialog)).toContain("Open this authorization link:");
  });

  it("stays silent for a browser-callback flow that never prompts for a pasted value", async () => {
    const flow = oauthFlow({
      auth: { url: "https://radius.example.com/authorize?flow=flow-1" },
      select: {
        requestId: "req-select",
        message: "How do you want to sign in?",
        options: [
          { value: "browser", label: "Sign in with browser" },
          { value: "device", label: "Sign in with device code" },
        ],
      },
    });
    const dialog = await mountDialog(oauthState({ machineId: "fleet-a", flow }), "https://pi.example.com/");
    expect(dialogText(dialog)).not.toContain(PASTE_NOTE_MARKER);
    expect(dialogText(dialog)).toContain("How do you want to sign in?");
  });

  it.each([["http://localhost:5173/"], ["http://127.0.0.1:5173/"], ["http://[::1]:5173/"]])(
    "keeps today's rendering when browser and runtime share a loopback namespace (%s)",
    async (pageUrl) => {
      const flow = oauthFlow({ prompt: MANUAL_CODE_PROMPT });
      const dialog = await mountDialog(oauthState({ flow }), pageUrl);
      expect(dialogText(dialog)).not.toContain(PASTE_NOTE_MARKER);
      expect(dialogText(dialog)).toContain("Open this authorization link:");
    },
  );

  it("leaves device-code flows unchanged when browser-remote", async () => {
    const flow = oauthFlow({ auth: { url: "https://github.com/login/device", deviceCode: { userCode: "ABCD-1234" } } });
    const dialog = await mountDialog(oauthState({ machineId: "fleet-a", flow }), "https://pi.example.com/");
    expect(dialogText(dialog)).not.toContain(PASTE_NOTE_MARKER);
    expect(dialogText(dialog)).toContain("Enter code:");
    expect(dialogText(dialog)).toContain("ABCD-1234");
  });

  it("keeps the paste note visible above the manual-code prompt input once the prompt lands", async () => {
    const flow = oauthFlow({ prompt: MANUAL_CODE_PROMPT });
    const dialog = await mountDialog(oauthState({ machineId: "fleet-a", flow }), "https://pi.example.com/");
    const text = dialogText(dialog);
    expect(text).toContain(PASTE_NOTE_MARKER);
    expect(text.indexOf(PASTE_NOTE_MARKER)).toBeLessThan(text.indexOf(MANUAL_CODE_PROMPT.message));
    expect(dialog.shadowRoot?.querySelector("input")).not.toBeNull();
  });
});

async function mountDialog(state: AuthDialogState, pageUrl: string): Promise<AuthDialog> {
  // happy-dom applies location.href assignments synchronously, so each test controls window.location.hostname.
  window.location.href = pageUrl;
  const dialog = new AuthDialog();
  dialog.state = state;
  document.body.append(dialog);
  await dialog.updateComplete;
  return dialog;
}

function dialogText(dialog: AuthDialog): string {
  return dialog.shadowRoot?.textContent ?? "";
}

function oauthState({ machineId = "local", flow = oauthFlow() }: { machineId?: string; flow?: OAuthFlowState } = {}): AuthDialogState {
  return { step: "oauth", flow, machineId, inputValue: "" };
}

function oauthFlow(overrides: Partial<OAuthFlowState> = {}): OAuthFlowState {
  return {
    flowId: "flow-1",
    providerId: "anthropic",
    providerName: "Anthropic",
    status: "running",
    auth: { url: "https://console.anthropic.com/oauth/authorize?flow=flow-1" },
    progress: [],
    ...overrides,
  };
}
