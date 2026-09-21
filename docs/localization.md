# Interface localization foundation

Settings → General includes an Auto / English / 简体中文 language selector. This first step translates the General settings heading, description, reload action, and language preference card. Other settings fields, navigation, chat, and plugins remain in English.

The preference takes effect immediately for translated components and is saved in this browser under `pi-web-app-language`. Auto recognizes `zh-CN`, `zh-SG`, and `zh-Hans` browser tags and falls back to English. Tabs on the same origin receive language changes through storage events; clearing local storage restores Auto. When storage is unavailable, the current tab can still change language.

Language selection does not change server or project configuration, prompts, agent responses, or session runtime ownership. No service restart is required.

## Architecture

- `src/client/src/i18n/locales/en.ts` defines message keys and interpolation parameter types. The Chinese catalog implements the same keys.
- `translate.ts` handles string lookup and interpolation without browser dependencies. Interpolation values remain text, including user-supplied names.
- `LocaleStore` owns the preference and browser effects: local storage, storage-event subscriptions, and the document language. It initializes explicitly or on first use, and exposes disposal for tests.
- `LocaleController` connects Lit component lifecycles to the locale store and requests an update when the language changes.
- `main.ts` initializes the shared store at application startup.

This scope introduces no package dependency, plugin API change, build-system change, or server/session-daemon change. Additional components can adopt the same controller and catalog incrementally. Plugin localization and value formatting are follow-up work, not part of this initial slice.

## Manual verification

1. Open Settings → General and select 简体中文. The panel heading and language card change immediately.
2. Refresh the page; the selected language persists.
3. Open a second tab at the same origin and change the language. Both language selectors update.
4. Change back to English. Existing configuration fields and their values remain intact.

Automated coverage checks catalog alignment and interpolation, locale negotiation, unavailable storage, subscription cleanup, live Lit rendering, persistence, and cross-tab events.
