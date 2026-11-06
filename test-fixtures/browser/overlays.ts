import { html, render } from "lit";
import { parse } from "@formatjs/icu-messageformat-parser";
import { printAST } from "@formatjs/icu-messageformat-parser/printer.js";
import { localization } from "../../src/client/src/localization/browser";
import { pseudoLocalize } from "../../src/client/src/localization/catalog";
import notificationMessages from "../../src/client/src/components/sessionNotifications.messages";
import { api, type Machine, type SessionStatus } from "../../src/client/src/api";
import { ConversationLayout } from "../../src/client/src/components/ConversationLayout";
import { ChatView } from "../../src/client/src/components/ChatView";
import { ContentRendererHost } from "../../src/client/src/components/ContentRendererHost";
import { PromptEditor } from "../../src/client/src/components/PromptEditor";
import { MachineSwitcher } from "../../src/client/src/components/MachineSwitcher";
import { ModalSurface } from "../../src/client/src/components/ModalSurface";
import { MessageActionsMenu } from "../../src/client/src/components/chat/MessageActionsMenu";
import { StatusBar } from "../../src/client/src/components/StatusBar";
import { SessionNoticesPanel } from "../../src/client/src/components/SessionNoticesPanel";
import { appStyles } from "../../src/client/src/components/shared";
import themeDefinitions from "../../pi-web-plugins/themes/package.json";
import playgroundDefinitions from "../../plugins/playground/package.json";
import { pluginStyles } from "../../src/client/src/plugins/styles";
import { applyPiWebTheme } from "../../src/client/src/theme";
import type { QualifiedThemeContribution } from "../../src/client/src/plugins/types";
import { NotificationArea } from "../../src/client/src/components/NotificationArea";
import type { NotificationGroup, NotificationItem } from "../../src/client/src/notificationArea";

api.commands = () => Promise.resolve([{ name: "tree", source: "builtin" }]);
api.files = () => Promise.resolve([{ path: "README.md", kind: "tracked" }]);
api.models = () => Promise.resolve({ models: [{ id: "test-model", name: "Test model", provider: "test" }] });

const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-border: #555; --pi-muted: #aaa; --pi-success-surface: #123d23; --pi-success: #4c8; --pi-overlay: #0008; --pi-accent: #aaf; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; }
  .conversation { height: 65vh; }
  modal-surface { --modal-surface-width: min(600px, 94vw); --modal-surface-max-height: 85dvh; }
  .modal-content { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
`;
document.head.append(style);

// Browser contracts explicitly opt into the checkout-only experimental plugin.
const fixtureThemes: QualifiedThemeContribution[] = [...themeDefinitions.piWeb.plugins, ...playgroundDefinitions.piWeb.plugins].flatMap((themePlugin) => themePlugin.themes.map((theme) => ({
  ...theme,
  id: `${themePlugin.id}:${theme.id}`,
  pluginId: themePlugin.id,
  localId: theme.id,
  colorScheme: theme.colorScheme === "light" ? "light" : "dark",
  stylesheets: theme.stylesheets.map((sheet) => ({
    ...sheet,
    id: `${themePlugin.id}:${theme.id}:${sheet.id}`,
    url: themePlugin.id === "playground"
      ? new URL(`../../plugins/playground/assets/${sheet.path}`, import.meta.url).href
      : new URL(`../../pi-web-plugins/themes/assets/${sheet.path}`, import.meta.url).href,
  })),
})));
pluginStyles.registerRoot(document);

const machine = (id: string, kind: Machine["kind"]): Machine => ({ id, name: id, kind, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" });
function switcher(): MachineSwitcher {
  const result = new MachineSwitcher();
  const local = machine("local", "local");
  result.machines = [local, machine("Remote", "remote")];
  result.selected = local;
  result.onRemove = () => undefined;
  return result;
}

let modalNumber = 0;
function openModal(): void {
  const modal = new ModalSurface();
  modal.label = `Dialog ${String(++modalNumber)}`;
  modal.initialFocus = "input";
  modal.onClose = () => { modal.remove(); };
  render(html`<div class="modal-content">
    <label>Dialog input <input aria-label="Dialog input"></label>
    ${switcher()}
    <button @click=${openModal}>Open nested dialog</button>
    <button @click=${() => { modal.busy = !modal.busy; }}>Toggle busy</button>
    <button @click=${() => { modal.remove(); }}>Close dialog</button>
  </div>`, modal);
  document.body.append(modal);
}
function openPluginModal(): void {
  const dialog = document.createElement("dialog");
  render(html`<label>Plugin input <input aria-label="Plugin input"></label>${switcher()}<button @click=${() => { dialog.close(); dialog.remove(); }}>Close plugin dialog</button>`, dialog);
  document.body.append(dialog);
  dialog.showModal();
}
const layout = new ConversationLayout();
layout.className = "conversation";
layout.sending = true;
const chat = new ChatView();
chat.messages = [{ role: "user", parts: [{ type: "text", text: "Chat messages behind suggestions" }] }];
layout.append(chat);
const editor = new PromptEditor();
editor.slot = "composer";
editor.sessionId = "browser-fixture";
editor.projectId = "fixture";
editor.workspaceId = "fixture";
editor.cwd = "/repo";
layout.append(editor);
const clippedSwitcher = switcher();
const messageActions = new MessageActionsMenu();
render(html`<button @click=${() => { messageActions.close(); }}>Copy fixture</button>`, messageActions);
const scrollingHost = document.createElement("div");
const scrollingRoot = scrollingHost.attachShadow({ mode: "open" });
render(html`<style>
  .scroll { height: 85px; overflow: auto; }
  .scroll-content { height: 500px; padding-top: 12px; }
  .clip { display: flex; align-items: center; gap: 10px; position: relative; transform: translateZ(0); overflow: hidden; height: 56px; padding: 8px; border: 1px solid #888; }
  machine-switcher { width: 240px; flex: 0 0 240px; }
</style><div class="scroll"><div class="scroll-content"><div class="clip">${clippedSwitcher}${messageActions}</div></div></div>`, scrollingRoot);
// Completion positioning measures the outermost shadow host as the app layout.
// Match PiWebApp's full-height fixed shell rather than making the editor itself
// the outermost host and accidentally constraining its menu to the input box.
const root = document.createElement("main");
root.style.cssText = "position: fixed; inset: 0; height: 100dvh; overflow: hidden;";
const application = root.attachShadow({ mode: "open" });
application.append(style.cloneNode(true));
document.body.append(root);
render(html`
  <div class="toolbar">
    <button @click=${openModal}>Open dialog</button>
    <button @click=${openPluginModal}>Open plugin dialog</button>
    <button @click=${() => { layout.sending = !layout.sending; }}>Toggle activity</button>
    <button @click=${() => { layout.toggleAttribute("hidden"); }}>Toggle conversation</button>
    <button @click=${() => { editor.sessionId = "another-session"; }}>Switch session</button>
  </div>
  ${layout}
  ${scrollingHost}
`, application);
await Promise.all([layout.updateComplete, editor.updateComplete, clippedSwitcher.updateComplete, messageActions.updateComplete]);

let notificationArea: NotificationArea | undefined;
let notificationItems: NotificationItem[] = [];
let notificationSequence = 24;
const notificationActions: string[] = [];
type NotificationRetryOutcome = "remove" | "replace" | "reject";
let finishNotificationRetry: (() => void) | undefined;

function projectNotifications(): void {
  if (!notificationArea) throw new Error("Notifications are not mounted");
  notificationArea.groups = (["browser", "server", "session"] as const).map((source): NotificationGroup => {
    const items = notificationItems.filter((item) => item.source === source);
    const capturedIds = new Set(items.map((item) => item.id));
    return {
      id: source,
      items,
      clear: () => {
        notificationActions.push(`clear:${source}`);
        notificationItems = notificationItems.filter((item) => !capturedIds.has(item.id));
        projectNotifications();
      },
    };
  });
}

function fixtureNotification(index: number): NotificationItem {
  const source = index === 0 ? "browser" : index === 1 ? "server" : "session";
  const id = `${source}:${String(24 - index)}`;
  return {
    id, source,
    severity: index < 3 ? "error" : index < 10 ? "warning" : "info",
    ...(source === "browser" ? {} : { scopeLabel: source === "server" ? "Local machine" : "Fixture session" }),
    message: `Notification ${String(24 - index)}: ${"long-resource-name/".repeat(12)}`,
    receivedAt: "2026-10-21T12:00:00Z",
    dismiss: () => {
      notificationActions.push(`dismiss:${id}`);
      notificationItems = notificationItems.filter((item) => item.id !== id);
      projectNotifications();
    },
    ...(source === "session" ? {} : { retry: () => { notificationActions.push(`retry:${id}`); } }),
  };
}

declare global {
  interface Window {
    overlayFixture: { complete: () => Promise<void>; openModal: () => void; openPluginModal: () => void; hideConversation: () => void; mountRenderer: () => Promise<void>; applyTheme: (id: string) => Promise<void>; mountStatistics: (safeArea: number) => Promise<void>; mountNotices: () => Promise<void>; mountNotifications: (pseudo?: boolean, withSession?: boolean, shortCount?: 1 | 9) => Promise<void>; addNotificationError: () => Promise<void>; notificationActions: string[]; prepareNotificationRetry: (outcome: NotificationRetryOutcome) => Promise<void>; finishNotificationRetry: () => void };
  }
}
window.overlayFixture = {
  notificationActions,
  complete: async () => {
    const view = editor.view;
    if (view === undefined) throw new Error("Editor is not mounted");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "/" }, selection: { anchor: 1 } });
    // Completion loading and rendering are asynchronous even with a fake API.
    await Promise.resolve();
    await Promise.resolve();
    await editor.updateComplete;
    await editor.updateComplete;
  },
  applyTheme: async (id) => {
    const theme = fixtureThemes.find((theme) => theme.id === id);
    if (!theme) throw new Error(`Missing fixture theme: ${id}`);
    await pluginStyles.setTheme(theme.stylesheets ?? [], () => { applyPiWebTheme(theme); });
  },
  mountRenderer: async () => {
    const renderer = new ContentRendererHost();
    renderer.id = "theme-renderer";
    renderer.text = "const retries = 3;";
    renderer.choices = [{ id: "highlighted", label: "Highlighted", renderer: {
      id: "highlighted", renderMode: "automatic", render: () => html`<code>Highlighted configuration</code>`,
    } }];
    application.prepend(renderer);
    await renderer.updateComplete;
  },
  mountStatistics: async (safeArea) => {
    const footer = new StatusBar();
    footer.slot = "status";
    layout.append(footer);
    layout.sending = false;
    layout.classList.remove("conversation");
    // Use the production shell's safe-area reservation and flex composition,
    // not a second implementation of its layout arithmetic.
    const shellStyles = document.createElement("style");
    shellStyles.textContent = appStyles.cssText;
    const shell = document.createElement("div");
    shell.className = "shell two-column-layout navigation-panel-collapsed";
    const main = document.createElement("main");
    main.append(layout);
    shell.append(main);
    application.replaceChildren(shellStyles, shell);
    root.style.setProperty("--pi-app-safe-area-bottom", `${String(safeArea)}px`);
    await Promise.all([layout.updateComplete, editor.updateComplete, footer.updateComplete]);
  },
  mountNotifications: async (pseudo = false, withSession = true, shortCount) => {
    if (pseudo) {
      // Built fixtures deliberately disable dev-only locale switches. Exercise the
      // same literal expansion via a test-only catalog, without changing the build.
      localization.registerCatalog({
        id: "notification-pseudo", namespace: "core.sessionNotifications", locale: "de",
        load: () => Promise.resolve(Object.fromEntries(Object.entries(notificationMessages).map(([key, definition]) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- FormatJS's public printer redeclares the parser's numeric TYPE enum.
          return [key, printAST(pseudoLocalize(parse(definition.message), false))];
        }))),
      });
      await localization.setPreferences({ language: "de", formatLocale: "en" });
    }
    await window.overlayFixture.mountStatistics(0);
    // Reparenting the shell tears down CodeMirror; mount a fresh composer in the
    // final containing block rather than testing a disconnected editor instance.
    const composer = new PromptEditor();
    composer.slot = "composer";
    composer.sessionId = "browser-fixture";
    composer.projectId = "fixture";
    composer.workspaceId = "fixture";
    composer.cwd = "/repo";
    editor.replaceWith(composer);
    await composer.updateComplete;
    chat.sessionId = "browser-fixture";
    chat.messages = Array.from({ length: 40 }, (_, index) => ({
      role: "user", parts: [{ type: "text", text: `Transcript entry ${String(index)}. ${"Enough conversation content to exercise independent transcript scrolling. ".repeat(4)}` }],
    }));
    notificationArea = new NotificationArea();
    notificationArea.contextKey = withSession ? "local:/repo:browser-fixture" : "local:no-session";
    notificationArea.onActionError = (error) => { notificationActions.push(`error:${String(error)}`); };
    notificationActions.length = 0;
    notificationItems = Array.from({ length: shortCount ?? 24 }, (_, index): NotificationItem => {
      const item = fixtureNotification(index);
      if (shortCount === undefined) return item;
      const severity = index === 0 ? "error" : index < 3 ? "warning" : "info";
      return { ...item, severity, message: `Test ${severity} #${String(index + 1)} — no real failure occurred.` };
    }).filter((item) => withSession || item.source !== "session");
    projectNotifications();
    layout.before(notificationArea);
    if (!withSession) layout.remove();
    const outside = document.createElement("input");
    outside.id = "outside-notifications";
    outside.setAttribute("aria-label", "Outside notifications");
    outside.style.cssText = "box-sizing: border-box; width: 100%;";
    notificationArea.before(outside);
    await Promise.all([chat.updateComplete, notificationArea.updateComplete]);
  },
  prepareNotificationRetry: async (outcome) => {
    if (!notificationArea) throw new Error("Notifications are not mounted");
    const item: NotificationItem = {
      id: "browser:async-retry", source: "browser", severity: "error", message: "Connection failed",
      retry: async () => {
        notificationActions.push("retry:async");
        await new Promise<void>((resolve) => { finishNotificationRetry = resolve; });
        if (outcome === "reject") throw new Error("Retry failed");
        notificationItems = outcome === "remove"
          ? notificationItems.filter((item) => item.id !== "browser:async-retry")
          : [{ id: "browser:retry-failure", source: "browser", severity: "error", message: "Connection still unavailable" }];
        projectNotifications();
      },
    };
    notificationItems = outcome === "remove"
      ? [item, { id: "server:adjacent", source: "server", severity: "warning", message: "Machine needs attention" }]
      : [item];
    projectNotifications();
    await notificationArea.updateComplete;
  },
  finishNotificationRetry: () => {
    if (!finishNotificationRetry) throw new Error("No pending notification retry");
    finishNotificationRetry();
    finishNotificationRetry = undefined;
  },
  addNotificationError: async () => {
    if (!notificationArea) throw new Error("Notifications are not mounted");
    const notification: NotificationItem = {
      id: `browser:latest-error-${String(++notificationSequence)}`, source: "browser", severity: "error",
      message: "Latest error requires attention", receivedAt: "2026-10-21T12:01:00Z",
    };
    notificationItems = [notification, ...notificationItems];
    projectNotifications();
    await notificationArea.updateComplete;
  },
  mountNotices: async () => {
    const panel = new SessionNoticesPanel();
    const status: SessionStatus = {
      sessionId: "notices-fixture", isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      warnings: Array.from({ length: 20 }, (_, index) => ({
        severity: "warning" as const, message: `Condition ${String(index)}: ${"long-resource-name/".repeat(20)}`,
        dismiss: { id: `notice-${String(index)}` },
      })),
    };
    panel.status = status;
    const container = document.createElement("section");
    container.id = "notices-boundary";
    container.style.cssText = "height: 160px; overflow: hidden;";
    container.append(panel);
    container.addEventListener("session-notice-dismiss", () => { container.dataset["dismissed"] = "true"; });
    application.prepend(container);
    await panel.updateComplete;
  },
  openModal,
  openPluginModal,
  hideConversation: () => { layout.hidden = true; },
};
document.body.dataset["ready"] = "true";
