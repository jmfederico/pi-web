# Workspace Reviews — source-only example

For the maintained, interactive demo that installs without compilation, use **Captain's Log** from **Settings → Pi packages → Available packages**. See [Captain's Log](../../docs/plugins.md#try-captains-log). This older example remains available for reference; its saved reviews are not migrated.

Review uncommitted workspace changes in a dedicated Pi session, save the findings, and browse them in a simple **Reviews** panel. This replaces the session-bridge greeting demo; it is **not installed or enabled by default**.

Copy this directory out of the repository or installed PI WEB package, then:

```sh
npm install
npm run build
```

Requires PI WEB `^2.202609.0` with the plugin data-directory and session-messaging APIs; the native companion is tested with Pi 0.85.1. During unreleased development, install the locally built PI WEB tarball instead of the registry dependency.

On the target machine, install the absolute package directory through **Settings → Pi packages**. Enable **Workspace Reviews** and its companion, and activate the backend with a manual session-daemon restart **when safe, from outside any session it hosts**. Reload the browser afterward. A web/API restart alone does not activate a new backend.

Select a workspace, open **Reviews**, and click **Start review**. Use **Refresh reviews** to load progress and saved results. Choose a saved review or use **Previous review / Next review** to read its plain text. The displayed full session id identifies the conversation in Sessions.

See [installation, behavior, storage, and limitations](docs/usage.md) before using this on sensitive code. Model credentials are required; packages and agent tools run with the machine user's permissions.
