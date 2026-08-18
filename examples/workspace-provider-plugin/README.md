# PI WEB dual-entry workspace-provider example

This standalone package is a copyable starting point for a trusted PI WEB plugin with both browser API v2 and server API v1 entries. It claims only projects that opt in with a marker file, publishes non-secret metadata to the browser, and demonstrates a browser request routed to the server provider that owns the workspace.

The example imports only the supported package declarations:

- `@jmfederico/pi-web/plugin-api`
- `@jmfederico/pi-web/server-plugin-api`

It requires PI WEB `1.202608.1` or newer, the first release that provides those entrypoints and browser API v2.

## Build and install

Copy `examples/workspace-provider-plugin/` out of the PI WEB repository or installed `@jmfederico/pi-web` package, then run:

```bash
npm install
npm run build
mkdir -p ~/.pi-web/plugins
ln -s "$PWD" ~/.pi-web/plugins/example-workspaces
```

If `PI_WEB_DATA_DIR` is set, link into `$PI_WEB_DATA_DIR/plugins` instead. The link name must be a valid plugin id and must not collide with another package.

Opt one registered PI WEB project into this example provider:

```bash
mkdir -p /absolute/path/to/project/.pi-web
touch /absolute/path/to/project/.pi-web/example-workspace-provider
```

Then restart the target session daemon and reload the browser:

```bash
systemctl --user restart pi-web-sessiond
```

Restarting `pi-web-sessiond.service` may interrupt active sessions and runtime ownership. A browser or web/API restart alone does not activate a server entry.

Open the opted-in project. The **Example Provider** panel displays the public marker metadata and its button calls the owning server provider's `summary` operation. Remove the marker and restart sessiond (or trigger a later workspace resolution) to stop claiming that project.

## Boundary demonstrated by the package

`package.json` declares:

- browser module `dist/browser/index.js` with `browserRoot: "dist/browser"`;
- server module `dist/server.js`, outside the browser root;
- `machineSpecific: true`, required for a dual browser/server entry.

Only files under `dist/browser/` can be served through this plugin's browser asset route. Source, package metadata, the server module, and dependencies remain outside that route. Keep secrets out of `publicMetadata`: it is visible to every browser script and API consumer.

The server provider intentionally does not advertise workspace removal. See the canonical plugin guide for removal-plan shell and completion semantics, package limits, federation behavior, and the complete API contract: <https://pi-web.dev/plugins>.
