---
"@jmfederico/pi-web": patch
---

Bound the idle-session transcript snapshot cache so a long-running session daemon no longer accumulates the parsed transcript of every session ever polled; snapshots are now evicted least-recently-used first past a small limit.

Fix status and message reads for idle sessions whose transcript file does not exist on disk (never persisted yet, or removed externally): they now serve the live runtime branch instead of failing.

Speed up polling of an idle session whose transcript file keeps growing: when another process appends to the file, only the appended bytes are read and parsed instead of the whole transcript being re-read every few seconds. Any change other than a pure append (replacement, truncation, in-place rewrite) still triggers a full re-read.

Stop polling of a never-persisted session from rescanning its session directory on every tick: transcript file resolution is now throttled, so an idle in-memory session polls at constant cost while still noticing a transcript file that appears later.

Stop a failing background poll of the selected session from churning the global error banner every few seconds: automatic poll failures are now only logged, while user-triggered refreshes still report errors.

Skip redundant work when a poll of the selected session changes nothing: a tick whose messages, status, and in-flight partial all match what is already shown no longer re-merges history, rewrites the cached transcript, or re-renders.
