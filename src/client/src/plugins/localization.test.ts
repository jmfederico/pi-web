// @vitest-environment happy-dom
import { LitElement, html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLocalization, MessageDefinition, LocalizationDiagnostic } from "../../../plugin-api.js";
import { LocalizationService, message } from "../localization/service.js";
import { createPluginLocalization } from "./localization.js";
import { PluginRegistry } from "./registry.js";

const definitions = { cancel: message("Cancel", "Cancel the operation") };

function activation(service: LocalizationService, runtime = "files") {
  const lifetime = new AbortController();
  return { lifetime, api: createPluginLocalization(service, "files", runtime, lifetime.signal) };
}

afterEach(() => { document.body.replaceChildren(); });

describe("plugin localization", () => {
  it("keeps federated source revisions independent at the same catalog address", async () => {
    const service = new LocalizationService({ preferences: { language: "fr", formatLocale: "en" } });
    const local = activation(service);
    const remote = activation(service, "remote-files");
    const messages = local.api.registerMessages("panel", definitions);
    const remoteMessages = remote.api.registerMessages("panel", {
      cancel: message("Cancel operation", "Updated translator context"),
      added: message("New action", "Action added in the newer plugin"),
    });
    expect(() => local.api.registerMessages("panel", definitions)).toThrow(/Duplicate/);
    const remove = local.api.registerCatalog({ id: "fr", namespace: "plugin:files:panel", locale: "fr", load: () => Promise.resolve({ cancel: "Annuler", added: "Nouvelle action" }) });
    await service.ready;
    expect(messages.t("cancel")).toBe("Annuler");
    expect(remoteMessages.t("cancel")).toBe("Annuler");
    expect(remoteMessages.t("added")).toBe("Nouvelle action");
    local.lifetime.abort();
    await service.ready;
    expect(messages.t("cancel")).toBe("Cancel");
    expect(remoteMessages.t("cancel")).toBe("Cancel operation");
    expect(() => service.registerMessages("plugin:files:panel", definitions)).toThrow(/Duplicate/);
    remove();
    remote.lifetime.abort();
    await service.ready;
    expect(service.registerMessages("plugin:files:panel", definitions).t("cancel")).toBe("Cancel");
  });

  it("activates different plugin revisions from two machines without localization rollback", async () => {
    const service = new LocalizationService();
    const registry = new PluginRegistry({ localization: service });
    let localLabel = () => "";
    let remoteLabel = () => "";
    try {
      await registry.register({ id: "files-local", sourcePluginId: "files", plugin: {
        apiVersion: 5, name: "Files", activate(context) {
          const messages = context.localization?.registerMessages("panel", definitions);
          localLabel = () => messages?.t("cancel") ?? "";
          return { contributions: {} };
        },
      } });
      await registry.register({ id: "files-remote", sourcePluginId: "files", machineId: "remote", plugin: {
        apiVersion: 5, name: "Files", activate(context) {
          const messages = context.localization?.registerMessages("panel", {
            cancel: message("Cancel operation", "New description"), added: message("Added", "New key"),
          });
          remoteLabel = () => messages?.t("cancel") ?? "";
          return { contributions: {} };
        },
      } });
      expect(registry.hasPlugin("files-local")).toBe(true);
      expect(registry.hasPlugin("files-remote")).toBe(true);
      expect(localLabel()).toBe("Cancel");
      expect(remoteLabel()).toBe("Cancel operation");
    } finally { await registry.dispose(); }
  });

  it("keeps a remote language pack on its machine while gateway packs apply everywhere", async () => {
    const service = new LocalizationService({ preferences: { language: "fr", formatLocale: "en" } });
    const messages = service.registerMessages("core.test", definitions);
    // The host verifies plugin availability only after a batch activates; catalogs must not depend on that gate.
    let verified = false;
    const registry = new PluginRegistry({ localization: service, isContributionEnabled: () => verified });
    const pack = async (id: string, cancel: string, machineId?: string) => {
      verified = false;
      await registry.register({ id, sourcePluginId: id, ...(machineId === undefined ? {} : { machineId }), plugin: {
        apiVersion: 5, name: id, activate(context) {
          context.localization?.registerCatalog({ id: "fr", namespace: "core.test", locale: "fr", load: () => Promise.resolve({ cancel }) });
          return { contributions: {} };
        },
      } });
      verified = true;
      await service.ready;
    };
    try {
      await pack("gateway-pack", "Annuler");
      expect(messages.t("cancel")).toBe("Annuler");
      await pack("remote-pack", "Annuler (distant)", "remote");
      expect(messages.t("cancel")).toBe("Annuler");
      service.setMachine("remote");
      await service.ready;
      expect(messages.t("cancel")).toBe("Annuler (distant)");
      service.setMachine("other");
      await service.ready;
      expect(messages.t("cancel")).toBe("Annuler");
    } finally { await registry.dispose(); }
  });

  it("lets queued detached renders read source messages without retaining activation registrations", async () => {
    const service = new LocalizationService({ preferences: { language: "fr", formatLocale: "en" } });
    const { api, lifetime } = activation(service);
    const messages = api.registerMessages("panel", {
      cancel: definitions.cancel,
      greeting: message<{ name: string }>("Hello {name}", "Greet the user"),
    });
    api.registerCatalog({ id: "fr", namespace: "plugin:files:panel", locale: "fr", load: () => Promise.resolve({ cancel: "Annuler" }) });
    await service.ready;
    class DetachedLocalizedTest extends LitElement {
      constructor() { super(); api.controller(this); }
      override render() { return html`<button>${messages.t("cancel")}</button>`; }
    }
    customElements.define("detached-localized-test", DetachedLocalizedTest);
    const element = new DetachedLocalizedTest();
    document.body.append(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Annuler");
    element.requestUpdate();
    element.remove();
    lifetime.abort();
    await expect(element.updateComplete).resolves.toBe(true);
    await service.ready;
    expect(element.shadowRoot?.textContent).toContain("Cancel");
    expect(messages.rich("greeting", { name: "Ada" })).toBe("Hello Ada");
    // A later activation may replace the same namespace; old handles stay detached.
    const replacement = service.registerMessages("plugin:files:panel", { cancel: message("Stop", "Stop the operation") });
    expect(replacement.t("cancel")).toBe("Stop");
    expect(messages.t("cancel")).toBe("Cancel");
    expect(() => api.registerMessages("later", definitions)).toThrow();
  });

  it("keeps dotted package and local namespace names distinct", () => {
    const service = new LocalizationService();
    const first = activation(service);
    const secondLifetime = new AbortController();
    const second = createPluginLocalization(service, "files.panel", "files.panel", secondLifetime.signal);
    const one = first.api.registerMessages("panel.tools", definitions);
    const two = second.registerMessages("tools", { cancel: message("Stop", "Stop the operation") });
    expect(one.t("cancel")).toBe("Cancel");
    expect(two.t("cancel")).toBe("Stop");
    first.lifetime.abort();
    secondLifetime.abort();
  });

  it("allows cross-plugin/core language packs with scoped IDs and log-only overlaps", async () => {
    const diagnostic = vi.fn<(diagnostic: LocalizationDiagnostic) => void>();
    const service = new LocalizationService({ preferences: { language: "fr", formatLocale: "de-DE" }, diagnostic });
    const core = service.registerMessages("core.files", definitions);
    const firstLifetime = new AbortController();
    const first = createPluginLocalization(service, "a-pack", "a-pack", firstLifetime.signal);
    const secondLifetime = new AbortController();
    const second = createPluginLocalization(service, "z-pack", "z-pack", secondLifetime.signal);
    const local = activation(service);
    const register = (api: PluginLocalization, translation: string) => {
      api.registerCatalog({ id: "core-fr", namespace: "core.files", locale: "fr", load: () => Promise.resolve({ cancel: translation }) });
      api.registerCatalog({ id: "files-fr", namespace: "plugin:files:panel", locale: "fr", load: () => Promise.resolve({ cancel: translation }) });
    };
    register(second, "Annuler Z");
    register(first, "Annuler A");
    const files = local.api.registerMessages("panel", definitions);
    await service.ready;
    expect(core.t("cancel")).toBe("Annuler Z");
    expect(files.t("cancel")).toBe("Annuler Z");
    expect(diagnostic.mock.calls.filter(([value]) => value.code === "duplicate")).toHaveLength(2);
    secondLifetime.abort();
    await service.ready;
    expect(core.t("cancel")).toBe("Annuler A");
    expect(files.t("cancel")).toBe("Annuler A");
    expect(local.api.number(1200.5)).toBe(new Intl.NumberFormat("de-DE").format(1200.5));
    local.lifetime.abort();
    firstLifetime.abort();
  });

  it("updates Lit hosts live, reconnects, and cancels observers at activation shutdown", async () => {
    const service = new LocalizationService({ development: true });
    const { api, lifetime } = activation(service);
    const messages = api.registerMessages("panel", definitions);
    await service.ready;
    class PluginLocalizedTest extends LitElement {
      constructor() { super(); api.controller(this); }
      override render() { return html`<button>${messages.t("cancel")}</button>`; }
    }
    customElements.define("plugin-localized-test", PluginLocalizedTest);
    const element = new PluginLocalizedTest();
    document.body.append(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Cancel");
    await service.setPreferences({ language: "en-XA", formatLocale: "en" });
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Cáncël");
    element.remove();
    await service.setPreferences({ language: "en", formatLocale: "en" });
    document.body.append(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Cancel");
    const update = vi.spyOn(element, "requestUpdate");
    lifetime.abort();
    await service.ready;
    update.mockClear();
    await service.setPreferences({ language: "ar-XB", formatLocale: "en" });
    expect(update).not.toHaveBeenCalled();
    expect(api.direction).toBe("rtl");
    expect(() => api.registerMessages("later", definitions)).toThrow();
    const lateObserver = vi.fn();
    api.subscribe(lateObserver);
    await service.setPreferences({ language: "en", formatLocale: "en" });
    expect(lateObserver).not.toHaveBeenCalled();
  });

  it("contains subscriber failures and supports early observer/catalog removal", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new LocalizationService();
    const { api, lifetime } = activation(service);
    const messages = api.registerMessages("panel", definitions);
    await service.ready;
    const remove = api.registerCatalog({ id: "fr", namespace: "plugin:files:panel", locale: "fr", load: () => Promise.resolve({ cancel: "Annuler" }) });
    api.subscribe(() => { throw new Error("Broken observer"); });
    api.subscribe(() => Promise.reject(new Error("Broken async observer")));
    const listener = vi.fn();
    const unsubscribe = api.subscribe(listener);
    try {
      await service.setPreferences({ language: "fr", formatLocale: "en" });
      await service.ready;
      expect(messages.t("cancel")).toBe("Annuler");
      expect(listener).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledTimes(4);
      unsubscribe();
      remove();
      remove();
      await service.ready;
      expect(messages.t("cancel")).toBe("Cancel");
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      lifetime.abort();
      warning.mockRestore();
    }
  });

  it("cleans registrations on failed activation/start, and on registry shutdown", async () => {
    const service = new LocalizationService({ preferences: { language: "fr", formatLocale: "en" } });
    const core = service.registerMessages("core.files", definitions);
    const registry = new PluginRegistry({ localization: service });
    let api: PluginLocalization | undefined;
    const plugin = {
      apiVersion: 5 as const,
      name: "Pack",
      activate(context: { localization?: PluginLocalization }) {
        api = context.localization;
        if (!api) throw new Error("Localization is required");
        api.registerMessages("panel", definitions);
        api.registerCatalog({ id: "fr", namespace: "core.files", locale: "fr", load: () => Promise.resolve({ cancel: "Annuler" }) });
        return { contributions: {}, start() { throw new Error("Failed start"); } };
      },
    };
    await expect(registry.register({ id: "pack", plugin: { ...plugin, activate(context) {
      plugin.activate(context);
      throw new Error("Failed activation");
    } } })).rejects.toThrow(/Failed activation/);
    await service.ready;
    expect(core.t("cancel")).toBe("Cancel");
    await expect(registry.register({ id: "pack", plugin })).rejects.toThrow(/Failed start/);
    await service.ready;
    expect(core.t("cancel")).toBe("Cancel");
    expect(() => api?.registerMessages("later", definitions)).toThrow();
    await registry.register({ id: "pack", plugin: { ...plugin, activate(context) {
      const result = plugin.activate(context);
      return { contributions: result.contributions };
    } } });
    await service.ready;
    expect(core.t("cancel")).toBe("Annuler");
    await registry.dispose();
    await service.ready;
    expect(core.t("cancel")).toBe("Cancel");
    const controller = new AbortController();
    controller.abort();
    const stopped = createPluginLocalization(service, "pack", "pack", controller.signal);
    expect(() => stopped.registerMessages("panel", definitions)).toThrow();
  });
});

// The published type-only API supports source modules without host-runtime imports.
const greeting: MessageDefinition<{ name: string }> = { message: "Hello {name}", description: "Greet the named user" };
function publicTypeContract(api: PluginLocalization): void {
  const messages = api.registerMessages("typed", { greeting, cancel: api.message("Cancel", "Cancel operation") });
  messages.t("greeting", { name: "Ada" });
  messages.t("cancel");
  // @ts-expect-error required interpolation
  messages.t("greeting");
  // @ts-expect-error unknown key
  messages.t("unknown");
}
void publicTypeContract;
