---
"@jmfederico/pi-web": patch
---

Update `pi-web install --dev` to use a supervised UI service group so a failed web or client process stops its sibling instead of leaving a partially running installation. Existing native development installations can adopt this by running `pi-web install --dev` from the updated checkout, retaining their existing `--config` option when applicable. Reinstalling services interrupts active sessions and terminals.
