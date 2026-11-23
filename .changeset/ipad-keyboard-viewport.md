---
"@jmfederico/pi-web": patch
---

Keep the iPad keyboard Shortcuts bar from covering the composer and status bar or moving the page. The first time the bar appears, PI WEB reserves its height at the bottom of the app and keeps that space on that iPad, including after reloads. The strip says what it is for and has a Remove button that frees the space until the bar appears again. While the bar is up, trackpad scrolling and touch drags that no panel can scroll no longer slide the whole page. Detection uses a small, stable viewport reduction while a text field is focused; other devices and the full software keyboard keep their existing behavior.
