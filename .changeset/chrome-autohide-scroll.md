---
"@jmfederico/pi-web": minor
---

Slide the chat header (context bar / mobile tabs) and the prompt input area out of the way when scrolling up through message history, and bring them back into view when scrolling down or when pinned to the live tail. The chat emits a `chat-chrome-visibility` event as scroll direction changes; the app collapses the header and input so the transcript reclaims the space, and keeps them visible while the composer is focused or a session is at the bottom.

Scrolling up now collapses the upper chrome as well as the prompt input: the `chrome-hidden` rule targets the `app-context-bar` / `app-mobile-main-tabs` host elements rather than the classes inside their shadow roots. The lower chrome is also kept clear of the Android system bar / iOS home indicator on first load by driving the app height from the live `window.innerHeight` and re-applying the measured `env(safe-area-inset-bottom)` on `load` / `pageshow` / `resize` / `orientationchange` / `visualViewport` resize.
