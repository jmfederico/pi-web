---
"@jmfederico/pi-web": patch
---

Show whole-entry message actions once per stored message instead of duplicating checkpoints on attached thinking. Message-level Fork and Go back retain all intervening history until the next distinct user/assistant checkpoint, including tool results and technical entries. Extensions observe the retained checkpoint when navigation completes. User-message draft restoration, exact-entry tree navigation, and cloning are unchanged; commands are not rerun.
