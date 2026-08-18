#!/usr/bin/env sh
set -eu

npm install -g @jmfederico/pi-web --allow-scripts=node-pty
pi-web install
