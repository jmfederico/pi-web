# Simplified Chinese language pack for PI WEB

An installable browser-only PI WEB plugin that provides the Simplified Chinese
(`zh-CN`) interface dictionary for the `core` message namespace. PI WEB ships
English by default; this package is installed separately and never compiled
into the main application bundle.

## Install

Pick one:

- **Settings → Pi packages**: install from this directory's local path, then reload the browser page.
- **Symlink** into the local plugin directory:

  ```sh
  mkdir -p ~/.pi-web/plugins
  ln -s /path/to/locale-packs/pi-web-locale-zh-cn ~/.pi-web/plugins/pi-web-locale-zh-cn
  ```

  If `PI_WEB_DATA_DIR` is set, use `$PI_WEB_DATA_DIR/plugins` instead. Reload
  the browser page after linking.

The package contains built JavaScript only; PI WEB does not compile it.

## Use

Open **Settings → General** and choose 简体中文, or leave the selector on Auto
and set Simplified Chinese as a preferred browser language (`zh-CN`, `zh-SG`,
and `zh-Hans*` tags are recognized). Missing dictionary entries fall back to
English entry by entry. The preference is saved per browser and shared across
same-origin tabs.

Disable or remove the plugin to return to English. The saved `zh-CN`
preference is retained and becomes active again when the pack is reinstalled.

## Updating dictionary keys

This pack mirrors the English defaults in
`src/client/src/i18n/locales/en.ts` (namespace `core`). When PI WEB adds new
English keys, older packs keep working: untranslated keys display English.
Add the new keys here and bump the package version to publish them.

## Language-pack marker

The package metadata declares `"languagePack": true`. Browser-only language
packs marked this way stay loadable even when the required Terminal plugin
fails to start, so interface translation keeps working during recovery. The
marker must agree with the browser/manifest entry PI WEB publishes; it cannot
be combined with a server module or `machineSpecific`.
