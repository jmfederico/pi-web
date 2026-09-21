# Captain's Log

Have a theatrical pirate captain retell the selected conversation's latest completed assistant reply, with nautical metaphors and humor while preserving the important facts. One button connects the browser, backend, and native Pi companion without changing the source conversation.

In **Settings → Pi packages → Available packages**, install **Captain's Log** on the target machine, then explicitly enable it in **Settings → PI WEB plugins**. The package ships prebuilt with PI WEB; no compilation is needed. For manual installation, use `pi install /absolute/path/to/dist/pi-packages/captains-log` with that machine's Pi profile.

Nothing in this package installs or enables itself. Activation of its server entry requires a **manual session-daemon restart when safe, from outside its hosted sessions**, followed by a browser reload. Restarts can interrupt active sessions. Existing sessions need `/reload` to load the native companion.

Select a conversation, open **Captain's Log** in the workspace tabs, and click **Let the Captain tell it**. The pirate conversation is reused while available, or created automatically. See [usage and recovery](docs/usage.md) for details. This is trusted agent code, not a read-only sandbox; requests use your configured model and may incur costs.

Maintainers: PI WEB's root `npm run build` emits the ready-to-install copy at `dist/pi-packages/captains-log/`. The package is not separately published to npm.
