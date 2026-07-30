---
"@jmfederico/pi-web": patch
---

Fix the chat composer (model picker and send button) being clipped at the bottom of the screen on Android standalone PWAs. The app reserves `env(safe-area-inset-bottom)` for the bottom safe area in standalone display modes, but on Android (Chromium edge-to-edge) that inset often resolves to `0` in the standalone WebView even though the gesture navigation bar overlaps content, so the bottom controls render behind it. Floor the reserved space with `max(env(safe-area-inset-bottom, 0px), 20px)` so the composer always clears the gesture bar; devices that report a real inset (e.g. the iOS home indicator) keep using it.
