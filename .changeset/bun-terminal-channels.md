---
"@jmfederico/pi-web": patch
---

Fix terminal channels under the Bun runtime: opening a terminal from the browser failed with "Plugin backend channel closed before ready (1011)" because the plugin-backend channel transport assumed npm `ws` internals when tightening its payload limit. The limit is now best-effort — transports without ws internals (Bun's native server sockets) skip it, and the same byte ceilings are still enforced by the bounded frame decoders on every message. Terminal service also no longer imports node-pty at module load, so the bundled Terminal plugin activates on bun installs where the optional binding is untrusted or absent.
