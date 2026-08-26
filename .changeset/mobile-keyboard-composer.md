---
"@jmfederico/pi-web": patch
---

Keep the chat composer visible above the mobile on-screen keyboard: the viewport now opts into `interactive-widget=resizes-content` (Android Chrome resizes the layout viewport so `100dvh` shrinks with the keyboard), and a new keyboard viewport controller pins the app shell to the visual viewport on iOS Safari, which never resizes the viewport for the keyboard.
