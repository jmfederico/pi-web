# To-dos for PI WEB

A standalone, opt-in package with a **To-dos** application tab and hosted Pi tools. One server stores the authoritative list in SQLite; client machines reach it through PI WEB's existing backend transport.

This first slice manages shared **unassigned** tasks: title, short context, Open / Doing / On hold / Done, and archive/restore. Project assignment and project filters are not available yet.

Requires Node >=22.19.0 and a PI WEB build with application backends, backend transport and `createCompanionBackend`. It is not shipped or automatically installed with PI WEB.

From this repository, with root dependencies installed:

```sh
npm run build
npm run build:todos
npm --prefix packages/todos test
npm run smoke:todos
```

Install the built directory through **Settings → Pi packages** on each participating machine, then configure its machine-global role and enable the plugin. See [usage and configuration](docs/usage.md) before restarting any daemon. No npm publication is required for a local directory install.
