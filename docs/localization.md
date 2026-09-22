# Interface localization

PI WEB's own browser interface text can display in languages provided by installable language packs. English is always available without any pack, every missing entry falls back to English item by item, and switching languages never reloads the page, restarts a session, or discards drafts and attachments.

Settings → General includes a language selector. With no language pack installed it offers Auto and English only; installing a pack adds its language to the list.

The preference takes effect immediately, is saved in this browser under `pi-web-app-language`, and is shared with same-origin tabs through storage events. Auto follows the browser language order and treats English as always available (`["en-US", "zh-CN"]` selects English). When storage is unavailable, the current tab still changes language.

Language selection does not change server or project configuration, system prompts, agent responses, or session runtime ownership.

## Language packs

A language pack is a browser-only PI WEB plugin that contributes dictionaries:

```js
export default {
  apiVersion: 4,
  name: "Simplified Chinese language pack",
  activate: () => ({
    contributions: {
      locales: [
        {
          id: "core",
          locale: "zh-CN",
          label: "简体中文",
          aliases: ["zh-Hans", "zh-SG"],
          namespace: "core",
          messages: { "settings.generalConfiguration": "常规配置" },
        },
      ],
    },
  }),
};
```

- One `LocaleContribution` covers one `(locale, namespace)` pair; `messages` keys are namespace-local plain text. Dynamic values use `{placeholder}` interpolation and stay escaped when rendered.
- Declare the package with `"languagePack": true` in its `piWeb.plugins` metadata. Marked packs are browser-only and stay loadable even when the required Terminal plugin fails, so translation survives recovery. The marker must be absent for every other plugin.
- Duplicate provision of the same `(locale, namespace, key)` fails plugin validation deterministically instead of silently overriding another pack.
- Remote machine language contributions never change the global interface language; only gateway-installed packs apply.
- Disabling or removing a pack returns the display to English while keeping the saved preference, which becomes active again when the pack returns.

A reference Simplified Chinese pack lives in this repository at `locale-packs/pi-web-locale-zh-cn/`; it is not compiled into the main application bundle and is installed separately. See its README for install steps.

## Architecture

- `src/client/src/i18n/locales/en.ts` defines the `core` namespace English defaults and their interpolation parameter types. Full keys are `${namespace}.${key}`, for example `core.settings.generalConfiguration`.
- `src/client/src/i18n/resources.ts` (`LocaleResourceStore`) merges registry-validated pack dictionaries, resolves Auto matching (tags, aliases, subtag prefixes), and performs message lookup with per-key English fallback. Development missing-key diagnostics install through `setMissingMessageKeyDiagnostics`.
- `translate.ts` holds pure interpolation helpers without browser dependencies.
- `LocaleStore` owns preference state: local storage, storage-event subscriptions, the document language, and the effective locale. It notifies subscribers whenever preference or published resources change, even when the language tag stays the same.
- `LocaleController` connects Lit component lifecycles to the store and exposes the generated language option list.
- The plugin registry validates, qualifies, publishes, and reverts locale contributions with the same prepare → start → publish lifecycle as other contributions; gateway-local packs are exposed through `getLocales()`.
- `PiWebApp` publishes installed packs to the shared resource store after each plugin load attempt and independently registers server-marked language packs when the required Terminal module fails to load.

Plugin-owned text (bundled plugin panels, actions) and server-origin notices migrate onto the same namespacing in later stages; see `docs/localization-copy-inventory.md` for the frozen key rules and per-area inventory.

## Manual verification

1. Without a language pack, Settings → General shows Auto and English only and the page works.
2. Install the standalone Chinese pack, reload; 简体中文 appears in the selector. Switching immediately translates the General heading, descriptions, actions, and the language card. Configuration form input is preserved.
3. Refresh and a second tab keep the selection.
4. Disable or remove the pack: display returns to English without erasing the saved `zh-CN` preference; reinstalling restores Chinese.
5. Simulate a Terminal plugin failure (for example, by breaking its module): language packs still load and translate while the Terminal failure is reported.

Automated coverage: registry locale contribution validation, duplicate and rollback semantics, remote isolation, disposal cleanup; locale store preference/auto resolution, resource arrival and disappearance, per-key fallback and interpolation, cross-tab events, unavailable storage; external manifest parsing of the language-pack marker including the required-Terminal failure path; settings panel option generation; catalog and manifest service publication of the marker.
