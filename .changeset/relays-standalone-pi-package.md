---
"@jmfederico/pi-web": patch
---

The `relays` plugin is now a standalone Pi package (`@jmfederico/pi-relay`, versioned independently, shipped at `pi-packages/relays/` inside `@jmfederico/pi-web`) instead of a bundled, directory-scanned PI WEB plugin. A plain `pi` user with no PI WEB installed can install it with `pi install <path>` and get the `/relay`/`/relay-worktree` prompt templates and the `relay` skill in any `pi` session. For PI WEB users, this stays zero-extra-steps: the session daemon now installs the package automatically for the active agent profile at startup if it is not already configured. Removing it from **Settings → Pi packages** is remembered per agent profile, so it will not be silently reinstalled later. Changed your mind? **Settings → Pi packages** now lists it under **Available packages** with a one-click **Install** button, so reinstalling it never requires typing its on-disk path. Publishing the package to npm remains deferred.
