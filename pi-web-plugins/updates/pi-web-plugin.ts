import type { TemplateResult } from "lit";
import type { HtmlTemplateTag, PiWebComponentStatus, PiWebPluginV5, PiWebStatusMessage, MaintenanceTerminal, PluginLocalization, PiWebInstallationInfo, PiWebStatusResponse, ApplicationPanelContextV5, RestartServices } from "@jmfederico/pi-web/plugin-api";
import { additionalCommands, fallbackDockerStatus, messageCount, recommendedCommand, shouldShowUpdatesPanel, statusFor, type CommandEntry, type UpdatesRuntimeHint } from "./updatesLogic.js";

import definitions from "./updates.messages.js";

function createUpdatesContent(localization: PluginLocalization, lifetimeSignal: AbortSignal) {
  // Only command preparation and terminal launch are pending, never service recovery.
  const pendingRestarts = new Map<string, RestartServices>();
  lifetimeSignal.addEventListener("abort", () => { pendingRestarts.clear(); }, { once: true });
  const messages = localization.registerMessages("panel", definitions);
  const t: typeof messages.t = messages.t.bind(messages);
  const formatVersion = (version: string | undefined): string => version === undefined || version === "" ? t("unknown") : version;
  const installationLabel = (installation: PiWebInstallationInfo | undefined): string => {
    if (installation?.kind === "pi-package") return localization.list([installation.source ?? t("piPackage"), ...(installation.scope === undefined ? [] : [installation.scope])]);
    if (installation?.kind === "npm-global") return t("npmGlobal");
    if (installation?.kind === "local") return t("local");
    if (installation?.kind === "docker") return t(installation.dockerMode === "dev" ? "dockerDev" : "docker");
    return t("installationUnknown");
  };
  const timestamp = (raw: string): string => {
    const value = Date.parse(raw);
    return Number.isNaN(value) ? t("statusUnavailable") : localization.date(value, { dateStyle: "medium", timeStyle: "short" });
  };

  function runCommandInTerminal(terminal: MaintenanceTerminal, label: string, command: string): void {
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
      ? t("unavailable")
      : component.stale
        ? t("restartNeeded")
        : t("current");
    return html`
      <div class="updates-version-row">
        <strong>${t(component.component === "web" ? "web" : "sessiond")}</strong>
        <span>${status}</span>
        <small>${t("versions", { running: formatVersion(component.runtimeVersion), installed: formatVersion(component.installedVersion) })}</small>
        <small>${installationLabel(component.installation)}${component.installation?.path === undefined ? "" : ` · ${component.installation.path}`}</small>
      </div>
    `;
  }

  async function requestRestart(context: ApplicationPanelContextV5, services: RestartServices): Promise<void> {
    const { lifecycle, machine, host } = context;
    const machineId = machine.id;
    if (lifetimeSignal.aborted || lifecycle === undefined || pendingRestarts.has(machineId)) return;
    // Guard immediately, before a rerender can disable the controls.
    pendingRestarts.set(machineId, services);
    host.requestRender();
    try {
      await lifecycle.requestRestart({ services, confirm: false });
    } catch (error: unknown) {
      // Core presents failures; consume the rejection without attempting a fallback.
      console.error("Updates plugin restart request failed", error);
    } finally {
      // Teardown clears the map, preventing late completion from rendering a disposed host.
      if (pendingRestarts.delete(machineId)) host.requestRender();
    }
  }

  function renderCommandActions(html: HtmlTemplateTag, context: ApplicationPanelContextV5, entry: CommandEntry): TemplateResult {
    const { lifecycle, maintenanceTerminal } = context;
    const pending = pendingRestarts.get(context.machine.id);
    return html`
      <span class="updates-command-actions">
        <button type="button" class="ui-button ui-button--action ui-button--compact" @click=${() => { void navigator.clipboard.writeText(entry.command); }}>${t("copy")}</button>
        ${entry.kind === "restart"
          ? lifecycle === undefined ? null : html`<button type="button" class="ui-button ui-button--action ui-button--compact ui-button--primary" ?disabled=${pending !== undefined} @click=${() => {
            void requestRestart(context, entry.services);
          }}>${pending === entry.services ? t("starting") : entry.label}</button>`
          : maintenanceTerminal === undefined ? null : html`<button type="button" class="ui-button ui-button--action ui-button--compact ui-button--primary" @click=${() => { runCommandInTerminal(maintenanceTerminal, entry.label, entry.command); }}>${t("run")}</button>`}
      </span>
    `;
  }

  function renderCommand(html: HtmlTemplateTag, context: ApplicationPanelContextV5, entry: CommandEntry): TemplateResult {
    return html`
      <div class="updates-command">
        <span>${entry.label}</span>
        <code>${entry.command}</code>
        ${renderCommandActions(html, context, entry)}
        ${entry.kind === "updatePi" ? html`<small class="updates-restart-warning">${t("updatePiWarning")}</small>` : null}
        ${entry.kind !== "restart" ? null : html`<small class="updates-restart-warning">${t(entry.services === "web" ? "restartWebWarning" : entry.services === "sessiond" ? "restartSessiondWarning" : "restartAllWarning")}${context.lifecycle === undefined ? ` ${t("restartUnavailable")}` : ""}</small>`}
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
  function localizeNotice(message: PiWebStatusMessage, status: PiWebStatusResponse): PiWebStatusMessage {
    const versions = (component: PiWebComponentStatus) => ({ running: formatVersion(component.runtimeVersion), installed: formatVersion(component.installedVersion) });
    switch (message.id) {
      case "update-available": {
        const installed = status.components.web.installedVersion ?? status.components.web.runtimeVersion;
        return { ...message, title: t("updateTitle"), body: t("updateBody", { latest: status.release.latestVersion ?? t("unknown"), installed: installed ?? "", known: installed === undefined ? "no" : "yes", command: status.commands.update === undefined ? "no" : "yes" }) };
      }
      case "web-stale": return { ...message, title: t("webTitle"), body: t("webBody", versions(status.components.web)) };
      case "sessiond-stale": return { ...message, title: t("sessiondTitle"), body: t("sessiondBody", versions(status.components.sessiond)) };
      case "sessiond-unavailable": return { ...message, title: t("unavailableTitle"), body: t("unavailableBody", { hasError: status.components.sessiond.error === undefined ? "no" : "yes", error: status.components.sessiond.error ?? "" }) };
      case "docker-status-compatibility": return { ...message, title: t("dockerTitle"), body: t("dockerBody") };
      // Future gateways can add notices unknown to this client. Keep their data
      // visible rather than guessing at its meaning or dropping safety guidance.
      default: return message;
    }
  }

  function renderNotice(html: HtmlTemplateTag, message: PiWebStatusMessage): TemplateResult {
    return html`
      <article class=${`updates-message ${message.severity}`}>
        <div class="updates-message-title"><strong>${message.title}</strong><span>${t(message.severity)}</span></div>
        <p>${message.body}</p>
      </article>
    `;
  }

  function renderNotices(html: HtmlTemplateTag, messages: readonly PiWebStatusMessage[]): TemplateResult {
    return html`
      <section>
        ${messages.length === 0 ? html`<p class="muted">${t("noMessages")}</p>` : messages.map((message) => renderNotice(html, message))}
      </section>
    `;
  }

  function renderRecommended(html: HtmlTemplateTag, context: ApplicationPanelContextV5, recommended: CommandEntry, messages: readonly PiWebStatusMessage[]): TemplateResult {
    return html`
      <section class="updates-recommended">
        <strong>${t("recommended")}</strong>
        ${messages.length === 0
          ? recommended.kind === "update" ? html`<p class="muted">${t("recommendedHelp")}</p>` : null
          : messages.map((message) => renderNotice(html, message))}
        ${renderCommand(html, context, recommended)}
      </section>
    `;
  }

  function renderAdditionalCommands(html: HtmlTemplateTag, context: ApplicationPanelContextV5, additional: readonly CommandEntry[], hasRecommended: boolean): TemplateResult | undefined {
    if (additional.length === 0) return undefined;
    return html`
      <section>
        <strong>${t(hasRecommended ? "additional" : "suggested")}</strong>
        ${hasRecommended ? html`<p class="muted">${t("additionalHelp")}</p>` : null}
        ${additional.map((entry) => renderCommand(html, context, entry))}
      </section>
    `;
  }

  function renderUpdatesPanel(html: HtmlTemplateTag, context: ApplicationPanelContextV5): TemplateResult {
    const status = statusFor(context.state) ?? fallbackDockerStatus(runtimeHint);
    if (status === undefined) {
      return html`
        <section class="ui-toolbar"><strong class="ui-toolbar-title">${t("updates")}</strong></section>
        <section class="viewer"><p class="muted">${t("checking")}</p></section>
      `;
    }

    const messages = status.messages.map((notice) => localizeNotice(notice, status));
    const recommended = recommendedCommand(status, (key) => t(key));
    const additional = additionalCommands(status, recommended, (key) => t(key));
    return html`
      <style>
        .updates-toolbar { flex: 0 0 auto; padding-inline: 12px; }
        .viewer.updates-status { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; padding: 12px; overflow-y: auto; overflow-x: hidden; }
        .viewer.updates-status section { flex: 0 0 auto; min-width: 0; display: grid; gap: 8px; }
        .updates-message { display: grid; gap: 5px; border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; background: var(--pi-surface); }
        .updates-message.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
        .updates-message.error { border-color: var(--pi-danger); }
        .updates-message-title { display: flex; gap: 8px; align-items: baseline; }
        .updates-message-title span { color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
        .updates-version-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 10px; border-bottom: 1px solid var(--pi-border-muted); padding: 6px 0; }
        .updates-version-row small { grid-column: 1 / -1; color: var(--pi-muted); overflow-wrap: anywhere; }
        .updates-command { min-width: 0; display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; gap: 8px; align-items: center; }
        .updates-command code { overflow: auto; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); padding: 5px 7px; white-space: nowrap; }
        .updates-command-actions { display: inline-flex; gap: 6px; }
        .updates-restart-warning { grid-column: 1 / -1; }
        .updates-recommended { border: 1px solid var(--pi-accent-border); border-radius: 8px; padding: 10px; background: var(--pi-surface); }
        .updates-recommended > strong { color: var(--pi-text-bright); }
        .updates-recommended .updates-message { border: none; background: none; padding: 0; }
        .updates-meta { display: grid; gap: 2px; color: var(--pi-muted); font-size: 12px; overflow-wrap: anywhere; }
        @container (max-width: 520px) {
          .updates-command { grid-template-columns: minmax(0, 1fr); }
          .updates-command-actions { justify-self: start; }
        }
      </style>
      <section class="ui-toolbar updates-toolbar"><strong class="ui-toolbar-title">${t("updates")}</strong>${messages.length > 0 ? html`<span class="stale">${localization.number(messages.length)}</span>` : null}</section>
      <section class="viewer updates-status">
        <section>
          <strong>${t("machine", { name: context.machine.name })}</strong>
          ${context.lifecycle !== undefined && (recommended?.kind === "restart" || additional.some((entry) => entry.kind === "restart")) ? html`<p>${t("restartDirect")}</p>` : null}
        </section>
        ${recommended === undefined
          ? renderNotices(html, messages)
          : renderRecommended(html, context, recommended, messages)}

        <section>
          <strong>${t("services")}</strong>
          ${renderComponent(html, status.components.web)}
          ${renderComponent(html, status.components.sessiond)}
        </section>

        ${renderAdditionalCommands(html, context, additional, recommended !== undefined)}

        <section class="updates-meta">
          <span>${t("generated", { time: timestamp(status.generatedAt) })}</span>
          ${status.release.latestVersion === undefined ? null : html`<span>${t("latest", { version: status.release.latestVersion })}</span>`}
          ${status.release.checkedAt === undefined || status.release.skipped === true ? null : html`<span>${t("checked", { time: timestamp(status.release.checkedAt) })}</span>`}
          ${status.release.skipped === true ? html`<span>${t("skipped")}</span>` : null}
          ${status.release.error === undefined ? null : html`<span>${t("failed", { error: status.release.error })}</span>`}
        </section>
      </section>
    `;
  }

  return { messages, renderUpdatesPanel, runtimeHint };
}

const plugin = {
  apiVersion: 5,
  name: "Updates",
  activate: ({ html, svg, localization, lifetimeSignal }) => {
    if (localization === undefined) throw new Error("Updates requires a localization-capable PI WEB host");
    const { messages, renderUpdatesPanel, runtimeHint } = createUpdatesContent(localization, lifetimeSignal);
    return {
      contributions: {
        actions: [
          {
            id: "check",
            get title() { return messages.t("check"); },
            get description() { return messages.t("checkDescription"); },
            get group() { return messages.t("updates"); },
            enabled: (context) => context.checkForPiWebUpdates !== undefined,
            disabledReason: () => messages.t("disabled"),
            run: (context) => context.checkForPiWebUpdates?.(),
          },
        ],
        applicationPanels: [
          {
            id: "workspace.updates",
            get title() { return messages.t("updates"); },
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
            render: (context) => renderUpdatesPanel(html, context),
          },
        ],
      },
    };
  },
} satisfies PiWebPluginV5;

export default plugin;
