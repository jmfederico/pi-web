---
"@jmfederico/pi-web": patch
---

Add `interactive-widget=resizes-content` to the viewport meta so Chromium-based mobile browsers resize the layout viewport while the on-screen keyboard is open, keeping the prompt composer visible above the keyboard. Browsers that ignore the directive keep their current behaviour.
