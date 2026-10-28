---
"@jmfederico/pi-web": patch
---

Keep the floating chat header where a scroll cannot bring it back: off the side-by-side layout the workspace view replaces the transcript, so the header stays put instead of following the last chat scroll. While the transcript is on screen the header still slides away on a downward scroll and returns on the first upward scroll, so collapsing a panel no longer holds it in place.
