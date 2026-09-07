import type { TemplateResult } from "lit";
import type { HtmlTemplateTag, PiWebComponentStatus, PiWebPlugin, PiWebStatusMessage, PluginRuntimeState, WorkspacePanelTerminal } from "@jmfederico/pi-web/plugin-api";
import { additionalCommands, fallbackDockerStatus, formatVersion, installationLabel, messageCount, recommendedCommand, shouldShowUpdatesPanel, statusFor, type CommandEntry, type UpdatesRuntimeHint } from "./updatesLogic.js";

function runCommandInTerminal(terminal: WorkspacePanelTerminal, label: string, command: string): void {
  void terminal.runCommand({
    title: label,
    command,
    open: true,
    metadata: { "pi.plugin": "updates" },
  }).catch((error: unknown) => {
    console.error(`Updates plugin failed to run "${label}"`, error);
  });
}

function renderComponent(html: HtmlTemplateTag, component: PiWebComponentStatus): TemplateResult {
  const status = !component.available
    ? "unavailable"
    : component.stale
      ? "restart needed"
      : "current";
  return html`
    <div class="updates-version-row">
      <strong>${component.label}</strong>
      <span>${status}</span>
      <small>running ${formatVersion(component.runtimeVersion)} · installed ${formatVersion(component.installedVersion)}</small>
      <small>${installationLabel(component.installation)}${component.installation?.path === undefined ? "" : ` · ${component.installation.path}`}</small>
    </div>
  `;
}

function renderCommandActions(html: HtmlTemplateTag, terminal: WorkspacePanelTerminal | undefined, label: string, command: string): TemplateResult {
  return html`
    <span class="updates-command-actions">
      <button @click=${() => { void navigator.clipboard.writeText(command); }}>Copy</button>
      ${terminal === undefined ? null : html`<button class="primary" @click=${() => { runCommandInTerminal(terminal, label, command); }}>Run</button>`}
    </span>
  `;
}

function renderCommand(html: HtmlTemplateTag, terminal: WorkspacePanelTerminal | undefined, label: string, command: string): TemplateResult {
  return html`
    <div class="updates-command">
      <span>${label}</span>
      <code>${command}</code>
      ${renderCommandActions(html, terminal, label, command)}
    </div>
  `;
}

function updatesRuntimeHintFromModuleUrl(moduleUrl: string): UpdatesRuntimeHint {
  try {
    const dockerMode = new URL(moduleUrl).searchParams.get("piWebDockerMode");
    return dockerMode === "runtime" || dockerMode === "dev" ? { dockerMode } : {};
  } catch {
    return {};
  }
}

const runtimeHint = updatesRuntimeHintFromModuleUrl(import.meta.url);

// Status notices never carry their own command row: every command a notice can
// reference already appears exactly once in this panel — either as the single
// recommended action or in the optional commands list — so the panel never
// presents two competing prominent actions for the same situation.
function renderNotice(html: HtmlTemplateTag, message: PiWebStatusMessage): TemplateResult {
  return html`
    <article class=${`updates-message ${message.severity}`}>
      <div class="updates-message-title"><strong>${message.title}</strong><span>${message.severity}</span></div>
      <p>${message.body}</p>
    </article>
  `;
}

function renderNotices(html: HtmlTemplateTag, messages: readonly PiWebStatusMessage[]): TemplateResult {
  return html`
    <section>
      ${messages.length === 0 ? html`<p class="muted">No PI WEB update or restart messages.</p>` : messages.map((message) => renderNotice(html, message))}
    </section>
  `;
}

function renderRecommended(html: HtmlTemplateTag, terminal: WorkspacePanelTerminal | undefined, recommended: CommandEntry, messages: readonly PiWebStatusMessage[]): TemplateResult {
  return html`
    <section class="updates-recommended">
      <strong>Recommended</strong>
      ${messages.length === 0
        ? html`<p class="muted">Run this one command to bring this installation fully up to date. Nothing else is required.</p>`
        : messages.map((message) => renderNotice(html, message))}
      ${renderCommand(html, terminal, recommended.label, recommended.command)}
    </section>
  `;
}

function renderAdditionalCommands(html: HtmlTemplateTag, terminal: WorkspacePanelTerminal | undefined, additional: readonly CommandEntry[], hasRecommended: boolean): TemplateResult | undefined {
  if (additional.length === 0) return undefined;
  return html`
    <section>
      <strong>${hasRecommended ? "Additional commands (optional)" : "Suggested commands"}</strong>
      ${hasRecommended ? html`<p class="muted">Only needed for finer control, such as restarting a single service.</p>` : null}
      ${additional.map((entry) => renderCommand(html, terminal, entry.label, entry.command))}
    </section>
  `;
}

function renderUpdatesPanel(html: HtmlTemplateTag, terminal: WorkspacePanelTerminal | undefined, state: PluginRuntimeState | undefined): TemplateResult {
  const status = statusFor(state) ?? fallbackDockerStatus(runtimeHint);
  if (status === undefined) {
    return html`
      <section class="toolbar"><strong>Updates</strong></section>
      <section class="viewer"><p class="muted">Checking PI WEB update status…</p></section>
    `;
  }

  const messages = status.messages;
  const recommended = recommendedCommand(status);
  const additional = additionalCommands(status, recommended);
  return html`
    <style>
      .viewer.updates-status { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; padding: 12px; overflow-y: auto; overflow-x: hidden; }
      .viewer.updates-status section { flex: 0 0 auto; min-width: 0; display: grid; gap: 8px; }
      .updates-message { display: grid; gap: 5px; border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; background: var(--pi-surface); }
      .updates-message.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
      .updates-message.error { border-color: var(--pi-danger); }
      .updates-message-title { display: flex; gap: 8px; align-items: baseline; }
      .updates-message-title span { color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
      .updates-version-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 10px; border-bottom: 1px solid var(--pi-border-muted); padding: 6px 0; }
      .updates-version-row small { grid-column: 1 / -1; color: var(--pi-muted); }
      .updates-command { min-width: 0; display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr) auto; gap: 8px; align-items: center; }
      .updates-command code { overflow: auto; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); padding: 5px 7px; white-space: nowrap; }
      .updates-command-actions { display: inline-flex; gap: 6px; }
      .updates-command-actions button.primary { border-color: var(--pi-accent-border); color: var(--pi-text-bright); }
      .updates-recommended { border: 1px solid var(--pi-accent-border); border-radius: 8px; padding: 10px; background: var(--pi-surface); }
      .updates-recommended > strong { color: var(--pi-text-bright); }
      .updates-recommended .updates-message { border: none; background: none; padding: 0; }
      .updates-meta { display: grid; gap: 2px; color: var(--pi-muted); font-size: 12px; }
      @media (max-width: 520px) {
        .updates-command { grid-template-columns: minmax(0, 1fr) auto; }
        .updates-command > span { grid-column: 1 / -1; }
      }
    </style>
    <section class="toolbar"><strong>Updates</strong>${messages.length > 0 ? html`<span class="stale">${String(messages.length)}</span>` : null}</section>
    <section class="viewer updates-status">
      ${recommended === undefined
        ? renderNotices(html, messages)
        : renderRecommended(html, terminal, recommended, messages)}

      <section>
        <strong>Installed services</strong>
        ${renderComponent(html, status.components.web)}
        ${renderComponent(html, status.components.sessiond)}
      </section>

      ${renderAdditionalCommands(html, terminal, additional, recommended !== undefined)}

      <section class="updates-meta">
        <span>Generated ${status.generatedAt}</span>
        ${status.release.latestVersion === undefined ? null : html`<span>Latest npm release ${status.release.latestVersion}</span>`}
        ${status.release.checkedAt === undefined || status.release.skipped === true ? null : html`<span>Release checked ${status.release.checkedAt}</span>`}
        ${status.release.skipped === true ? html`<span>Remote version check skipped.</span>` : null}
        ${status.release.error === undefined ? null : html`<span>Remote version check failed: ${status.release.error}</span>`}
      </section>
    </section>
  `;
}

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Updates",
  activate: ({ html, svg }) => ({
    contributions: {
      actions: [
        {
          id: "check",
          title: "Check for PI WEB Updates",
          description: "Bypass cached release data and check the selected machine now",
          group: "Updates",
          enabled: (context) => context.checkForPiWebUpdates !== undefined,
          disabledReason: () => "Update checks require a newer PI WEB gateway",
          run: (context) => context.checkForPiWebUpdates?.(),
        },
      ],
      workspacePanels: [
        {
          id: "workspace.updates",
          title: "Updates",
          icon: svg`
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6v5h-5"></path>
              <path d="M4 18v-5h5"></path>
              <path d="M18.4 9A7 7 0 0 0 6.1 6.7L4 8.8"></path>
              <path d="M5.6 15A7 7 0 0 0 17.9 17.3L20 15.2"></path>
            </svg>
          `,
          order: 100,
          visible: (context) => shouldShowUpdatesPanel(context.state, runtimeHint),
          badge: (context) => {
            const count = messageCount(context.state);
            return count > 0 ? count : undefined;
          },
          render: (context) => renderUpdatesPanel(html, context.terminal, context.state),
        },
      ],
    },
  }),
};

export default plugin;
