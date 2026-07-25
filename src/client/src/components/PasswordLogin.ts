import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { request } from "../api/http";
import { saveToken } from "../passwordAuth";

export interface PasswordLoginResult {
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePasswordLoginResult(value: unknown): PasswordLoginResult {
  if (!isRecord(value)) throw new Error("Invalid login response");
  const token = value["token"];
  if (typeof token !== "string") throw new Error("Invalid login response");
  return { token };
}

@customElement("pi-web-password-login")
export class PasswordLogin extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--pi-bg);
      font-family: system-ui, -apple-system, sans-serif;
    }
    .card {
      background: var(--pi-bg);
      border: 1px solid var(--pi-border);
      border-radius: 12px;
      padding: 2.5rem;
      width: 360px;
      box-shadow: 0 8px 32px var(--pi-shadow);
    }
    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.4rem;
      color: var(--pi-text);
    }
    p {
      margin: 0 0 1.5rem;
      font-size: 0.85rem;
      color: var(--pi-text-secondary);
    }
    label {
      display: block;
      margin-bottom: 0.35rem;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--pi-muted);
    }
    input {
      width: 100%;
      padding: 0.6rem 0.75rem;
      margin-bottom: 1rem;
      border: 1px solid var(--pi-border);
      border-radius: 6px;
      background: var(--pi-surface);
      color: var(--pi-text);
      font-size: 0.9rem;
      box-sizing: border-box;
      outline: none;
    }
    input:focus {
      border-color: var(--pi-accent);
    }
    .error {
      color: var(--pi-danger);
      font-size: 0.8rem;
      margin-bottom: 0.75rem;
    }
    button {
      width: 100%;
      padding: 0.65rem;
      border: none;
      border-radius: 6px;
      background: var(--pi-accent);
      color: var(--pi-bg);
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  `;

  @state() private username = "";
  @state() private password = "";
  @state() private error = "";
  @state() private loading = false;

  private readonly handleUsernameInput = (event: InputEvent): void => {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.username = event.target.value;
  };

  private readonly handlePasswordInput = (event: InputEvent): void => {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.password = event.target.value;
  };

  private readonly handleSubmit = (e: Event): void => {
    e.preventDefault();
    if (this.loading) return;
    this.error = "";
    this.loading = true;
    void request<PasswordLoginResult>("api/auth/login", parsePasswordLoginResult, {
      method: "POST",
      body: JSON.stringify({ username: this.username, password: this.password }),
    })
      .then(({ token }) => {
        saveToken(token);
        this.dispatchEvent(new CustomEvent("login-success", { bubbles: true, composed: true }));
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : "Login failed";
      })
      .finally(() => {
        this.loading = false;
      });
  };

  override render() {
    return html`
      <div class="card">
        <h1>PI WEB</h1>
        <p>Enter credentials to access the web interface</p>
        <form @submit=${this.handleSubmit}>
          <label for="username">Username</label>
          <input
            id="username"
            type="text"
            autocomplete="username"
            placeholder="admin"
            .value=${this.username}
            @input=${this.handleUsernameInput}
            ?disabled=${this.loading}
          />
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
            .value=${this.password}
            @input=${this.handlePasswordInput}
            ?disabled=${this.loading}
          />
          ${this.error ? html`<div class="error">${this.error}</div>` : ""}
          <button type="submit" ?disabled=${this.loading}>
            ${this.loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "pi-web-password-login": PasswordLogin;
  }
}
