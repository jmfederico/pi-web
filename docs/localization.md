# Localization development

PI WEB's localization engine uses FormatJS ICU messages and the runtime's native `Intl` data. English is the source and fallback language. Core UI and bundled plugins use the engine, browser adapter, and activation-scoped plugin API.

## Define complete messages

Keep source definitions in `*.messages.ts` modules with a default export. These modules contain definitions only, without browser effects or registration. CI discovers core and bundled-plugin source files by this convention and validates ICU syntax and translator descriptions.

```ts
import { message } from "../localization/service.js";

export default {
  files: message<{ count: number }>(
    "{count, plural, one {# file} other {# files}}",
    "Number of files in the current folder",
  ),
  cancel: message("Cancel", "Cancel the current operation"),
};
```

Register the definitions once in the owning module, outside the definition file:

```ts
import definitions from "./files.messages.js";
import { localization } from "../localization/browser.js";

export const filesMessages = localization.registerMessages("core.files", definitions);
filesMessages.t("files", { count: 3 });
filesMessages.t("cancel");
```

Keys and explicitly declared value types are checked by TypeScript. ICU structure is checked at runtime and in the source-validation test. Supply the full message, not concatenated translated fragments. Use ICU `plural`, `selectordinal`, and `select` for grammatical alternatives. Keep user content, model responses, code, paths, and identifiers in interpolation values; never use them as source messages or translation keys.

Add `new LocalizationController(this)` to each localized Lit component (import from `localization/browser.js`). It requests updates when preferences or catalogs change, unsubscribes on disconnection, and reconnects automatically. Non-Lit consumers can use `localization.subscribe(listener)` and must call the returned cleanup function.

## Format regional values

Use `localization.number(value, options)`, `date(value, options)`, `time(value, options)`, `relativeTime(value, unit, options)`, and `list(values, options)`. They use native `Intl` formatting. ICU number/date/time arguments use the same regional preferences; plural rules use the language of the selected message, including English fallback.

Preferences are independent:

```ts
await localization.setPreferences({
  language: "fr-CA",
  formatLocale: "de-DE",
  timeZone: "America/Toronto",
  hourCycle: "h23",
});
```

`language` requests the UI catalog; `formatLocale` selects regional conventions. The browser supplies both unless the gateway config provides defaults. Omitted overrides inherit the corresponding gateway default, if configured; otherwise, `timeZone` uses the runtime's local zone and `hourCycle` follows regional conventions. Explicit preferences override individual date/time formatting options. Currency must always be supplied explicitly, for example `{ style: "currency", currency: "CAD" }`; it is never inferred from a locale.

Open **Settings → General → Language and region** to apply preferences to this browser across all machines and projects. The interface-language list includes only English and the catalog languages available on the selected machine. If the requested language is unavailable, the selector shows the resolved fallback; applying saves the displayed choice. Language packs may provide partial translations; missing messages fall back to English. Regional format and Time zone are optional overrides, empty until explicitly set. Leave either blank to inherit its gateway default, if configured, otherwise the browser’s locale or time zone. The inherited source and value appear below each field as **Gateway default** or **Browser default**. Explicit values can use a standard language tag such as `en-GB` or `de-DE`, or a time-zone name such as `Europe/Berlin` or `UTC`. Clear a field and click **Apply to this browser** to resume inheritance for that field. Clock format offers Regional default, 12-hour, and 24-hour (0–23); a configured gateway clock default takes precedence when no clock override is set. The preview shows the currently applied formats, not unsubmitted edits.

**Use defaults** removes all browser-local localization overrides. Each field independently inherits its gateway default, then the browser/runtime value. Loading the app does not save inherited values as overrides. Defaults are resolved at page startup, so a later reload picks up browser or gateway changes.

Operators can set optional `defaultLocalization` fields in the [global gateway config](config.md#localization-defaults). Each omitted field uses browser/runtime defaults; language never implies a format locale, time zone, or currency. Defaults are read at page startup and do not become saved device choices merely by loading catalogs. Reload the tab to pick up changed defaults. Selected-machine and project config do not affect this preference.

The browser adapter persists only explicit overrides under `pi-web-localization` in browser storage. Existing saved snapshots remain explicit overrides until cleared; their original intent cannot be inferred. The internal service exposes resolved `preferences`, separate `preferenceOverrides` and `preferenceDefaults`, and `setPreferenceOverrides()` for applying or clearing individual overrides. Removing the storage key and reloading also restores inheritance. It updates document language to the resolved UI language (English when no translated catalog is available) and direction from native locale data. `service.preferences.language` retains the requested language even when catalogs are unavailable.

## Contribute translations

The engine accepts lazy translation contributions. Core modules register directly with the service:

```ts
const remove = localization.registerCatalog({
  id: "my-language-pack:core-files-fr",
  namespace: "core.files",
  locale: "fr",
  load: () => import("./fr.js").then((module) => module.default),
});
await localization.ready;
// On owner disposal:
remove();
await localization.ready;
```

A catalog is a partial map from local message keys to ICU strings. Contributions can target their own namespace, core, or another plugin. They may arrive before their target source namespace. Catalogs load only when their locale belongs to the requested UI-language fallback chain; each registered loader runs at most once, including failed loaders. Each catalog publishes independently as it loads. A slow or broken pack cannot block healthy packs, preference persistence, or usable English fallback UI. A load that rejects or exceeds five seconds logs a failure and uses other valid contributions or English; a late result is ignored. To retry, remove and register the contribution again, or reload the app. Removing a contribution settles its pending load and restores the next matching translation or English.

Resolution is deterministic: less-specific locales apply first (`fr` before `fr-CA`); within one locale, contributions sort by stable ID using code-unit lexical order, with later IDs winning overlapping entries. Completion timing and registration order do not determine the winner. IDs must be globally unique. Duplicate *message entries* are allowed and logged only, without user-visible conflict warnings.

Invalid entries are logged and ignored individually. Placeholder/tag names and value kinds must match the source; translated plurals can use different categories. When different plugin versions share a namespace, entries are checked against each activation’s own definitions. A compatible entry is used for that activation; an incompatible entry leaves its next valid translation or English source in place. Loader failures are logged and fall back to English or another valid contribution. Missing-message diagnostics are development-only. The exported `validateCatalog(source, catalog)` helper in `localization/catalog.js` supports catalog-author tests; runtime validation also protects dynamically loaded catalogs.

## Plugin localization

Browser plugins receive `context.localization` during activation. Feature-detect it when supporting older hosts. The public `@jmfederico/pi-web/plugin-api` entry remains type-only: do not import runtime functions from it. `localization.message` provides the descriptor helper without bundling a second engine.

```ts
activate({ localization }) {
  if (!localization) throw new Error("This plugin requires a localization-capable PI WEB host");
  const messages = localization.registerMessages("panel", {
    cancel: localization.message("Cancel", "Cancel the current operation"),
  });
  // Full source namespace: plugin:<package ID>:panel
  // Use messages.t("cancel") when rendering, not a snapshot taken during activation.
  // For Lit components, call localization.controller(this) in the constructor.
  return { contributions: {} };
}
```

For source-only `*.messages.ts` files without runtime imports, use typed descriptors:

```ts
import type { MessageDefinition } from "@jmfederico/pi-web/plugin-api";

const cancel: MessageDefinition<Record<string, never>> = {
  message: "Cancel", description: "Cancel the current operation",
};
const greeting: MessageDefinition<{ name: string }> = {
  message: "Hello {name}", description: "Greet the named user",
};
export default { cancel, greeting };
```

Pass the imported default definitions to `localization.registerMessages("panel", definitions)` during activation. Local namespace names start with a lowercase letter and contain lowercase letters, digits, dots, or hyphens. The host forms `plugin:<source package ID>:<local namespace>`, not a machine-specific name. Colon separators avoid collisions between dotted package and namespace names. Each activation owns its source definitions while sharing the same package/local namespace as a stable catalog address. Different plugin versions can coexist across machines: added keys, wording changes, or translator-context changes do not disable another activation or replace its English fallback. Catalog entries are validated separately against each activation’s schema. Keep a key’s meaning stable; use a new key when the meaning changes, since structural validation cannot detect a semantic mismatch. A namespace can be registered once per activation, and its source registration is removed when that activation ends. Existing message handles remain readable using their English source fallback (or the current development pseudo mode), so queued renders can finish safely after teardown. They do not retain catalog registrations or read a replacement activation's messages. New registrations remain forbidden after activation shutdown.

Plugins contribute lazy catalogs using `localization.registerCatalog({ id, namespace, locale, load })`. Supply a full target namespace, such as `core.files` or `plugin:files:panel`; language packs may target any namespace. The host scopes each catalog ID as the JSON tuple `[runtimePluginId, id]`. The normal lexical precedence rule applies to those full IDs, regardless of registration/load order. This permits identical local IDs from different installed plugins and deterministic overlaps between their catalogs. A catalog applies only on the machine whose plugin provides it: a remote machine's catalogs apply while that machine is selected, and gateway catalogs apply on every machine unless the gateway plugin is hidden there. Switching machines can therefore change the displayed language without changing the saved preference. The returned function removes that catalog early; activation failure, failed start, and host shutdown automatically remove all owned catalogs, sources, and observers. Aborted activations cannot register new resources; existing message handles use the source fallback described above.

Regional helpers, read-only preferences, `language`, `direction`, and `ready` are available on the same object. `ready` is a snapshot promise for the currently requested language’s registered catalog loads, resolving when each has loaded, failed, timed out, or been removed. It is not required for rendering: handles always have English source fallback, and subscriptions publish healthy catalogs as they arrive. Core preference setters commit and notify synchronously; their returned promise follows the same bounded catalog readiness. Browser settings save the committed choices without waiting for that promise. `subscribe(listener)` supports non-Lit hosts and returns early cleanup; otherwise observers live until activation shutdown. Plugins cannot change global preferences through this API. Use string getters for live contribution labels, for example `get title() { return messages.t("info"); }`. The host preserves getters for action titles/descriptions/groups, panel titles, renderer titles and theme names/descriptions when qualifying contributions. Keep IDs, selectors, ordering and behavior stable. Do not evaluate translated strings once during activation. Host-owned Lit surfaces subscribe to language changes; independently mounted non-Lit plugin surfaces must subscribe and request their own render. The bundled Info plugin demonstrates source definitions, live labels, localized diagnostics and regional timestamps.

## Safe rich messages

Use named ICU tags and caller-owned Lit callbacks, never translated HTML or `unsafeHTML`:

```ts
import { html } from "lit";
import { message, type RichMessageTag } from "../localization/service.js";

const definitions = {
  notice: message<{ name: string; strong: RichMessageTag }>(
    "Open <strong>{name}</strong>",
    "Emphasized file name in an opening notice",
  ),
};
const messages = localization.registerMessages("example", definitions);
messages.rich("notice", {
  name: fileName,
  strong: (parts) => html`<strong>${parts}</strong>`,
});
```

The application owns elements and attributes. Translation validation rejects new tag names and attributes; interpolation values remain text bindings in Lit. `t()` is for plain text; use `rich()` when callbacks return templates.

## Pseudo-localization

In a Vite development build, open the application with `?pseudoLocale=en-XA` for expanded accented text or `?pseudoLocale=ar-XB` for right-to-left text and document direction. Preserve any existing query values when adding the parameter. The query override does not persist a pseudo language preference. Production services reject pseudo locales.

Pseudo-localization transforms only English literal ICU nodes, including branches and tag contents. Interpolated paths, user text, numbers, and code remain unchanged. It exercises only migrated messages; untranslated legacy UI is not automatically transformed. As areas migrate, check long labels, wrapping, narrow layouts, keyboard navigation, and logical start/end positioning in both modes.

## Checks

Run `npm test -- src/client/src/localization` for engine, browser/Lit integration, and automatic English source validation. Add translation validation tests beside language-pack catalogs. Follow the repository's scoped lint, typecheck, and delivery-check guidance for changes to the implementation.
