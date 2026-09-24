#!/usr/bin/env sh
set -eu

# PI WEB runs on Node or Bun: the installed commands and services choose their runtime when they
# start, so how you install the package does not lock you into a runtime. npm is the blessed path
# here because --allow-scripts makes npm run node-pty's install script, which builds the native
# PTY binding used under Node.
#
# PI_WEB_INSTALLER=bun installs through bun instead (terminals then use Bun's own PTY API):
#   PI_WEB_INSTALLER=bun curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/install.sh | sh
# bun runs a dependency's install script only when you trust it, so node-pty may end up unbuilt.
# That does not affect bun-run terminals; if you want the binding anyway, run
# `bun pm trust node-pty` and reinstall.

case "${PI_WEB_INSTALLER:-npm}" in
  npm)
    npm install -g @jmfederico/pi-web --allow-scripts=node-pty
    ;;
  bun)
    bun add -g @jmfederico/pi-web
    ;;
  *)
    printf 'install.sh: PI_WEB_INSTALLER=%s is not supported. Use npm or bun.\n' "$PI_WEB_INSTALLER" >&2
    exit 2
    ;;
esac

pi-web install
