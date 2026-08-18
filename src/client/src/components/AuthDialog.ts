import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { AuthDialogState } from "../appState";
import type { AuthProviderOption, OAuthFlowState } from "../api";
import { LOCAL_MACHINE_ID } from "../machineKeys";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import type { ModalSurface } from "./ModalSurface";
import { scrollWhenSelected } from "./scrollWhenSelected";

/** One keyboard-navigable choice on the option-list steps (method, providers, logout). */
interface AuthDialogOption {
  /** Stable identity, used to avoid redundant scrolling on re-render. */
  key: string;
  title: TemplateResult | string;
  detail: string;
  /** Plain text matched by the provider search box, independent of the rendered title. */
  searchText: string;
  run: () => void;
}

@customElement("auth-dialog")
export class AuthDialog extends LitElement {
  @property({ attribute: false }) state?: AuthDialogState;
  @property({ attribute: false }) onChooseMethod?: (authType: "oauth" | "api_key") => void;
  @property({ attribute: false }) onSelectProvider?: (providerId: string, authType: "oauth" | "api_key") => void;
  @property({ attribute: false }) onLogoutProvider?: (providerId: string) => void;
  @property({ attribute: false }) onOAuthInput?: (value: string) => void;
  @property({ attribute: false }) onOAuthRespond?: (value?: string) => void;
  @property({ attribute: false }) onOAuthCancel?: () => void;
  @property({ attribute: false }) onCancel?: () => void;
  @query("modal-surface") private surface?: ModalSurface;
  @state() private selectedIndex = 0;
  /** Search box text on the provider-list steps; scoped to the current step. */
  @state() private query = "";

  override render() {
    const state = this.state;
    if (state === undefined) return null;
    return html`
      <modal-surface
        .onClose=${() => { this.cancel(); }}
        .initialFocus=${this.initialFocusTarget(state)}
        .label=${this.dialogTitle(state)}
        @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
      >
        <header>
          <strong>${this.dialogTitle(state)}</strong>
          <button title="Close" aria-label="Close" @click=${() => { this.cancel(); }}>×</button>
        </header>
        ${this.renderBody(state)}
      </modal-surface>
    `;
  }

  /** Selectable choices for the option-list steps; undefined on the oauth step, which has no roving selection. */
  private optionsFor(state: AuthDialogState): AuthDialogOption[] | undefined {
    switch (state.step) {
      case "method":
        return [
          { key: "oauth", title: "Use a subscription", detail: "ChatGPT Plus/Pro, Claude Pro/Max, or GitHub Copilot", searchText: "Use a subscription", run: () => { this.onChooseMethod?.("oauth"); } },
          { key: "api_key", title: "Use provider credentials", detail: "Configure an API key or provider-specific credentials in the active Pi-compatible profile's auth.json", searchText: "Use provider credentials", run: () => { this.onChooseMethod?.("api_key"); } },
        ];
      case "providers":
        return state.providers.map((provider) => ({
          key: provider.id,
          title: html`${provider.name}${provider.status.source !== undefined ? html` <em>${statusLabel(provider)}</em>` : null}`,
          detail: `${provider.id} · ${authTypeLabel(provider.authType)}`,
          searchText: provider.name,
          run: () => { this.onSelectProvider?.(provider.id, provider.authType); },
        }));
      case "logout":
        return state.providers.map((provider) => ({
          key: provider.id,
          title: provider.name,
          detail: `${provider.id} · ${authTypeLabel(provider.authType)}`,
          searchText: provider.name,
          run: () => { this.onLogoutProvider?.(provider.id); },
        }));
      case "oauth":
        return undefined;
    }
  }

  /** The search box target for the step: the OAuth prompt input or the provider search box. */
  private initialFocusTarget(state: AuthDialogState): string | undefined {
    if (state.step === "oauth") return state.flow.prompt !== undefined ? "input" : undefined;
    if (state.step === "providers" || state.step === "logout") return state.providers.length > 0 ? "input" : undefined;
    return undefined;
  }

  /** Whether the step renders a searchable provider list (selecting or removing stored credentials). */
  private stepHasSearch(state: AuthDialogState): boolean {
    return state.step === "providers" || state.step === "logout";
  }

  private handleSearchInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.query = event.target.value;
      // Filtering replaces the list beneath the roving selection: start back at its first option.
      this.selectedIndex = 0;
    }
  }

  private filteredOptions(options: AuthDialogOption[]): AuthDialogOption[] {
    const query = this.query.trim().toLowerCase();
    if (query === "") return options;
    return options.filter((option) => `${option.searchText} ${option.detail} ${option.key}`.toLowerCase().includes(query));
  }

  /** The options actually rendered for the step: the roving selection and keyboard navigation see these. */
  private visibleOptions(state: AuthDialogState): AuthDialogOption[] {
    const options = this.optionsFor(state);
    return options === undefined ? [] : this.filteredOptions(options);
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (!changed.has("state")) return;
    if (authDialogStateStep(changed.get("state")) !== this.state?.step) {
      // Selection and search text are scoped to the visible option list:
      // entering a step starts at its first option with an empty query.
      this.selectedIndex = 0;
      this.query = "";
      return;
    }
    const options = this.state === undefined ? undefined : this.visibleOptions(this.state);
    if (options !== undefined) this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, options.length - 1));
  }

  protected override updated(changed: PropertyValues): void {
    if (!changed.has("state")) return;
    const previousStep = authDialogStateStep(changed.get("state"));
    if (previousStep === undefined) return;
    const currentStep = this.state?.step;
    const stepChanged = previousStep !== currentStep;
    const oauthInteractionChanged = previousStep === "oauth"
      && currentStep === "oauth"
      && oauthInteractionKey(changed.get("state")) !== oauthInteractionKey(this.state);
    // Step changes and same-step OAuth interaction changes can replace the
    // focused control. Reapply the surface's input-or-dialog focus contract so
    // keyboard events never become stranded on the page.
    if (stepChanged || oauthInteractionChanged) this.surface?.focusDialog();
  }

  private dialogTitle(state: AuthDialogState): string {
    switch (state.step) {
      case "method": return "Configure provider authentication";
      case "providers": return state.authType === undefined ? "Select provider authentication" : state.authType === "oauth" ? "Select subscription provider" : "Select credential provider";
      case "oauth": return `Login to ${state.flow.providerName}`;
      case "logout": return "Remove stored provider authentication";
    }
  }

  private renderBody(state: AuthDialogState) {
    if (state.step === "oauth") return this.renderOAuth(state);
    const options = this.optionsFor(state) ?? [];
    const visible = this.filteredOptions(options);
    return html`
      ${this.stepHasSearch(state) && options.length > 0 ? html`
        <input aria-label="Search providers" placeholder="Search providers" .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }}>
      ` : null}
      <div class="options">
        ${options.length === 0 ? html`<div class="empty">${state.step === "logout" ? "No stored credentials. Environment variables and models.json settings are unchanged." : "No providers available."}</div>`
        : visible.length === 0 ? html`<div class="empty">No matching providers</div>`
        : visible.map((option, index) => html`
          <button
            class=${index === this.selectedIndex ? "selected" : ""}
            aria-current=${index === this.selectedIndex ? "true" : nothing}
            ${scrollWhenSelected(index === this.selectedIndex, option.key)}
            @focus=${() => { this.selectedIndex = index; }}
            @click=${() => { option.run(); }}
          >
            <span>${option.title}</span>
            <small>${option.detail}</small>
          </button>
        `)}
      </div>
    `;
  }

  private renderOAuth(state: Extract<AuthDialogState, { step: "oauth" }>) {
    const flow = state.flow;
    const prompt = flow.prompt;
    const select = flow.select;
    const promptInputType = prompt === undefined ? undefined : oauthPromptInputType(prompt.promptType);
    // Only a manual-code prompt accepts a pasted redirect URL, so the note stays out of
    // device-code and browser-callback flows that offer the user nothing to paste.
    const showPasteNote = isBrowserRemoteOAuthMachine(state.machineId, window.location.hostname)
      && flow.status === "running"
      && prompt?.promptType === "manual_code";
    return html`
      <div class="form">
        ${flow.auth !== undefined ? html`
          <p>Open this authorization link:</p>
          <p><a href=${flow.auth.url} target="_blank" rel="noreferrer">${flow.auth.url}</a></p>
          ${flow.auth.deviceCode !== undefined ? html`
            <p class="warning">Enter code: <code>${flow.auth.deviceCode.userCode}</code></p>
          ` : flow.auth.instructions !== undefined ? html`<p class="warning">${flow.auth.instructions}</p>` : null}
        ` : html`<p>Starting login flow…</p>`}
        ${showPasteNote ? html`<p class="warning">After you approve, the redirect page will probably fail to load — that is expected. Copy the full URL from your browser's address bar and paste it below.</p>` : null}
        ${flow.progress.length > 0 ? html`<ul class="progress">${flow.progress.map((line) => html`<li>${line}</li>`)}</ul>` : null}
        ${flow.info?.map((item) => item.links === undefined || item.links.length === 0 ? null : html`
          <div class="info-links" aria-label="Related information">
            ${item.links.map((link) => html`<a href=${link.url} target="_blank" rel="noreferrer" title=${item.message}>${link.label ?? link.url}</a>`)}
          </div>
        `) ?? null}
        ${prompt !== undefined ? html`
          <label>${prompt.message}</label>
          <input type=${promptInputType} autocomplete=${promptInputType === "password" ? "off" : "on"} .value=${state.inputValue ?? ""} placeholder=${prompt.placeholder ?? ""} @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.onOAuthInput?.(event.target.value); }}>
          <div class="actions"><button @click=${() => { this.onOAuthCancel?.(); }}>Cancel</button><button class="primary" ?disabled=${state.responding === true} @click=${() => { this.onOAuthRespond?.(); }}>Submit</button></div>
        ` : null}
        ${select !== undefined ? html`
          <p>${select.message}</p>
          <div class="inline-options">${select.options.map((option) => html`
            <button @click=${() => { this.onOAuthRespond?.(option.value); }}>
              <span>${option.label}</span>
              ${option.description === undefined ? null : html`<small>${option.description}</small>`}
            </button>
          `)}</div>
        ` : null}
        ${state.error !== undefined && state.error !== "" ? html`<div class="error-text">${state.error}</div>` : null}
        ${flow.status === "error" || flow.status === "cancelled" ? html`<div class="error-text">${flow.error ?? flow.status}</div><div class="actions"><button @click=${() => { this.cancel(); }}>Close</button></div>` : null}
        ${prompt === undefined && select === undefined && flow.status === "running" ? html`<div class="actions"><button @click=${() => { this.onOAuthCancel?.(); }}>Cancel</button></div>` : null}
      </div>
    `;
  }

  // Escape is owned by the modal surface (routed to `cancel`). List-level
  // navigation and prompt submission deliberately defer to native buttons so
  // their focused Enter behavior remains authoritative.
  private handleKeyDown(event: KeyboardEvent): void {
    const state = this.state;
    if (state === undefined || keyboardEventOriginatesFromNativeActivationControl(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const options = this.visibleOptions(state);
      if (options.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + delta + options.length) % options.length;
      return;
    }
    if (event.key !== "Enter") return;
    if (state.step === "oauth") {
      if (state.flow.prompt === undefined) return;
      event.preventDefault();
      this.onOAuthRespond?.();
      return;
    }
    const option = this.visibleOptions(state)[this.selectedIndex];
    if (option === undefined) return;
    event.preventDefault();
    option.run();
  }

  private cancel(): void {
    const state = this.state;
    if (state?.step === "oauth") this.onOAuthCancel?.();
    else this.onCancel?.();
  }

  static override styles = [css`
    :host { position: fixed; inset: 0; z-index: 10; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    modal-surface { --modal-surface-width: min(720px, calc(100vw - 40px)); --modal-surface-max-height: min(640px, calc(100vh - 40px)); }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    .options { min-height: 0; overflow: auto; outline: none; }
    button { border: 0; background: transparent; color: var(--pi-text); cursor: pointer; }
    header button { font-size: 20px; color: var(--pi-muted); }
    input { margin: 10px 12px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); padding: 8px 10px; outline: none; }
    input:focus { border-color: var(--pi-accent); }
    .options button { display: block; width: 100%; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); text-align: left; }
    .options button.selected, .options button:hover { background: var(--pi-selection-bg); }
    small { display: block; margin-top: 4px; color: var(--pi-muted); }
    .empty { padding: 24px; color: var(--pi-muted); text-align: center; }
  `, css`
    .form { display: grid; gap: 12px; padding: 14px; overflow: auto; }
    .form p { margin: 0; color: var(--pi-text-secondary); overflow-wrap: anywhere; }
    .form a { color: var(--pi-accent); overflow-wrap: anywhere; }
    .form code { border: 1px solid var(--pi-border); border-radius: 4px; background: var(--pi-surface); padding: 1px 4px; }
    label { color: var(--pi-muted); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    .actions button, .inline-options button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; }
    .actions button.primary { border-color: var(--pi-success-border); background: var(--pi-success-surface); color: var(--pi-success); }
    .actions button:disabled { opacity: .6; cursor: wait; }
    .warning { color: var(--pi-warning); }
    .error-text { color: var(--pi-danger); }
    .progress { margin: 0; padding-left: 18px; color: var(--pi-muted); }
    .info-links { display: flex; flex-wrap: wrap; gap: 8px 12px; }
    .inline-options { display: grid; gap: 8px; }
    .inline-options button { display: grid; gap: 2px; text-align: left; }
    .inline-options small { color: var(--pi-muted); }
    em { color: var(--pi-success); font-style: normal; font-size: 12px; }
  `];
}

export function oauthPromptInputType(promptType: NonNullable<OAuthFlowState["prompt"]>["promptType"]): "text" | "password" {
  return promptType === "secret" ? "password" : "text";
}

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

/** True when `hostname` names the machine the browser itself runs on. */
export function isLoopbackHostname(hostname: string): boolean {
  // Browsers report IPv6 hostnames bracketed, e.g. "[::1]".
  return loopbackHostnames.has(hostname.trim().replace(/^\[|\]$/g, "").toLowerCase());
}

/**
 * True when the OAuth loopback redirect (`http://localhost:<port>/callback`) cannot
 * reach the runtime from this browser: the flow runs on a federated machine, or the
 * gateway host is not loopback-local to the browser. The user must then paste the
 * redirect URL manually.
 */
export function isBrowserRemoteOAuthMachine(machineId: string, hostname: string): boolean {
  return machineId !== LOCAL_MACHINE_ID || !isLoopbackHostname(hostname);
}

function authTypeLabel(authType: "oauth" | "api_key"): string {
  return authType === "oauth" ? "subscription" : "credentials";
}

/**
 * Identity of the controls rendered for an OAuth interaction. Polling updates
 * that preserve this key must not steal focus; changes indicate that the
 * focused prompt/selection/action may have been replaced.
 */
function oauthInteractionKey(value: unknown): string | undefined {
  if (authDialogStateStep(value) !== "oauth" || typeof value !== "object" || value === null || !("flow" in value)) return undefined;
  const flow = value.flow;
  if (typeof flow !== "object" || flow === null) return undefined;
  const flowId = "flowId" in flow && typeof flow.flowId === "string" ? flow.flowId : "";
  const promptRequestId = "prompt" in flow ? oauthInteractionRequestId(flow.prompt) : undefined;
  if (promptRequestId !== undefined) {
    const responsePhase = "responding" in value && value.responding === true ? "responding" : "ready";
    return `${flowId}:prompt:${promptRequestId}:${responsePhase}`;
  }
  const selectRequestId = "select" in flow ? oauthInteractionRequestId(flow.select) : undefined;
  if (selectRequestId !== undefined) return `${flowId}:select:${selectRequestId}`;
  const status = "status" in flow && typeof flow.status === "string" ? flow.status : "unknown";
  return `${flowId}:waiting:${status}`;
}

function oauthInteractionRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return undefined;
  return typeof value.requestId === "string" ? value.requestId : undefined;
}

/** Step of a previous `state` value read from a PropertyValues map, without type assertions. */
function authDialogStateStep(value: unknown): AuthDialogState["step"] | undefined {
  if (typeof value !== "object" || value === null || !("step" in value)) return undefined;
  switch (value.step) {
    case "method":
    case "providers":
    case "oauth":
    case "logout":
      return value.step;
    default:
      return undefined;
  }
}

function statusLabel(provider: AuthProviderOption): string {
  if (provider.status.source === undefined) return "";
  switch (provider.status.source) {
    case "stored": return "✓ configured";
    case "environment": return `✓ env${provider.status.label === undefined ? "" : `: ${provider.status.label}`}`;
    case "runtime": return "✓ runtime";
    case "fallback": return "✓ custom key";
    case "models_json_key": return "✓ models.json key";
    case "models_json_command": return "✓ models.json command";
    default: return "";
  }
}

