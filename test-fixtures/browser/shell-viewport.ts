import { css, html, LitElement } from "lit";
import { appStyles } from "../../src/client/src/theme/base/shellStyles";
import { ShellViewportController } from "../../src/client/src/appShell/shellViewportController";

// Production fixed host and grid, with independently scrolling panel content.
// Browser tests inject viewport measurements; they do not emulate an iOS keyboard.
class ViewportShell extends LitElement {
  static override styles = [appStyles, css`
    :host { --pi-bg: #161616; --pi-text: #eee; --pi-border: #555; }
    conversation-layout { display: block; overflow: auto; }
    .messages { height: 3000px; background: linear-gradient(#222, #555); }
    .composer-area { padding: 8px; }
    textarea { box-sizing: border-box; width: 100%; }
    status-bar { display: block; padding: 8px; }
  `];

  constructor() {
    super();
    new ShellViewportController(this);
  }

  override render() {
    return html`<div class="shell two-column-layout">
      <main>
        <header>Navigation</header>
        <conversation-layout aria-label="Conversation"><div class="messages">Messages</div></conversation-layout>
        <div class="composer-area"><textarea aria-label="Message"></textarea></div>
        <status-bar>Ready</status-bar>
      </main>
    </div>`;
  }
}
customElements.define("viewport-shell", ViewportShell);
