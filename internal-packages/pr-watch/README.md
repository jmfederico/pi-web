# PR watch (internal)

Development tool for working on PI WEB. Not part of the PI WEB release: `internal-packages/` is outside the npm `files` allowlist, and its build output stays in each package's own `dist/`.

A session subscribes to a GitHub pull request. When CodeRabbit reviews, comments, replies, or reports a rate limit, PR watch sends the session a follow-up message. An idle session starts a new turn. If the session is busy, PR watch retries on the next poll.

## Install

1. In the PI WEB checkout used by the target session daemon, build the package:

   ```sh
   npm run build:internal
   ```

2. Install `<checkout>/internal-packages/pr-watch` as a local package source in **Settings → Pi packages**.
3. Enable the `pr-watch` plugin in **Settings → PI WEB plugins**. It is disabled by default.
4. Restart the session daemon, then reload the browser. **Restarting the daemon interrupts active sessions and terminals.**

Rebuild and restart the daemon after pulling changes to this package.

## Settings

Set these in the normal PI WEB configuration under `plugins.pr-watch.settings`. Invalid or unknown keys stop the plugin from starting.

| Key | Default | Meaning |
| --- | --- | --- |
| `ghCommand` | `"gh"` | `gh`-compatible executable used for all GitHub reads. The daemon's `PATH` may differ from an agent shell's; use an absolute path for wrappers. On servers with the agent identity wrappers, use `/data/pi-agent/bin/gh-agent`. |
| `pollIntervalSeconds` | `60` | Time between checks (15–3600). |
| `quietSeconds` | `60` | Wait after the last new item, so one burst becomes one message (0–3600). |
| `maxHoldMinutes` | `30` | Send anyway if CodeRabbit's check stays in progress this long (1–1440). |
| `authors` | `["coderabbitai[bot]"]` | Reviewer logins to watch. A `[bot]` login also selects that App's check runs. |
| `maxWakesPerHour` | `12` | Limit on messages per subscription, to stop runaway agent/reviewer loops (1–120). Activity is held, not dropped. The final merged/closed message is exempt because it ends the subscription. |
| `maxAgeDays` | `14` | Subscriptions end silently after this age (1–365). |

## Agent tools

- `pr_watch_subscribe({ pr })` accepts a URL, number, or branch, resolved with `gh pr view` in the session's workspace. It returns the CodeRabbit activity that already exists; only later activity triggers messages. Subscribing twice is harmless.
- `pr_watch_list()` shows this session's subscriptions and recent removals, with reasons.
- `pr_watch_unsubscribe({ subscriptionId })`.

## What triggers a message

Only activity by the configured `authors`:

- New reviews, except automatic dismissals and empty comment reviews that only wrap thread replies.
- New inline comments and thread replies. Later edits, such as marking a finding addressed, are ignored.
- New or edited conversation comments, including command replies that CodeRabbit posts first and completes later.
- A rate-limit notice in the walkthrough summary. Other summary edits are ignored.
- Completion of CodeRabbit's check run on the head commit.

New items are held while CodeRabbit's check is in progress and until no new item has appeared for `quietSeconds`. The message lists each item with a short excerpt and link; the agent reads the details with `gh`. When the pull request is merged or closed, the session receives a final message and the subscription ends.

## When subscriptions end

Before each check, every subscription's session is verified through the PI WEB catalog:

- **Archived session:** removed at once.
- **Deleted session, removed workspace, or unregistered project:** removed after two consecutive checks that successfully read the catalog and did not find it.
- **Catalog read failure** (for example during daemon startup or workspace discovery): the subscription is kept. A failed read never counts as absence, and it does not reset a streak either: absent, failed, absent removes the subscription.

The session is checked again just before each delivery. Unarchiving a session does not restore its subscriptions; subscribe again.

## Delivery and failures

Delivery loads a saved session if needed and waits for the companion extension to confirm the message appears in the session transcript. Busy sessions are retried without counting as delivery failures. A rejection is logged with the extension's reason. Unacknowledged or rejected messages are retried with backoff, reusing the same ID so a retry never produces a second turn. Newer activity, including the final merged/closed message, waits behind an unacknowledged message. A message already sending when its subscription is removed may still arrive. After five failed delivery attempts, PR watch records a warning notice on that session. After three consecutive GitHub read failures for a pull request, it records a warning notice and reports degraded health until a read succeeds; individual failures are logged.

State is stored in `subscriptions.json` in the plugin's data directory.
