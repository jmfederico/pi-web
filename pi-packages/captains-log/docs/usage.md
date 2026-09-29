# Using Captain's Log

Select a conversation in the current workspace, open **Captain's Log**, and click **Let the Captain tell it**. The companion reads that session's latest completed assistant reply without sending it a prompt or changing its transcript. A separate pirate conversation retells the text using your configured model. The prompt asks for a fresh, theatrical crew briefing with nautical metaphors and humor—not just a few pirate words. It asks the model to preserve important facts, warnings, and next steps, and keep code and commands exact.

The pirate gets a short introduction on its first prompt and keeps speaking pirate. Further translations use the same conversation while it is loaded in the session daemon. If it is no longer loaded, the next translation automatically creates a new pirate conversation. There are no confirmation dialogs, workspace reviews, or plain-English mode.

To keep the previous pirate's context after a daemon restart, open the most recent **Captain's Log** conversation in Sessions before translating. Once loading finishes, the plugin can reuse it; it need not remain selected. Then select the conversation whose reply you want translated. The plugin does not automatically reopen saved sessions or stop/delete old sessions.

## Results and connections

Use **Open source session** beneath a translation to return to its original conversation in chat, even when another conversation is selected. This action uses the record's machine/project/workspace scope and source session ID. If the source is no longer available, PI WEB shows its normal unavailable-destination message; it does not create a replacement conversation.

- The translation is rendered as Markdown, including headings, lists, emphasis, links, tables, and code blocks. Embedded HTML stays literal, unsafe links are inert, and images are not loaded automatically. **Previous translations** holds earlier results; **Diagnostics** holds session/request IDs and the message trail. Both start collapsed. Existing review-era logs remain on disk but are not shown as translations.
- The panel inherits PI WEB's workspace styles and themes. The action-palette **Open pirate translator** opens it without spending model tokens.
- Browser requests and backend progress use a bidirectional peer channel, with no polling. Opening or reconnecting loads a snapshot. Progress is not token-by-token model streaming; the completed translation arrives when the pirate finishes.
- Closing the panel or browser does not cancel admitted work. Reconnect to recover the result. Requests with uncertain delivery are never automatically resent. Automatic pirate creation happens only before sending a translation, when the previous pirate is confirmed unhosted—not after a timeout or arbitrary connection failure.

## When a translation cannot run

Select an ordinary, unarchived conversation in the same workspace and machine, not the pirate itself. Wait for it to finish responding. It needs a completed assistant reply with text; partial, aborted, failed, and tool-call-only replies are not translations. If the native companion is missing from an existing session, use `/reload` in that session and try again.

Only one panel translation per workspace runs at a time. Busy pirates, direct user messages during a translation, provider errors, aborted or truncated replies, and runtime replacement are reported as failures rather than successful translations. A receipt timeout or completion timeout detaches listeners but does not stop Pi. Inspect the pirate conversation before retrying an uncertain request. Very large source replies or results are rejected rather than silently truncated; see Diagnostics for the reason.

Translations and metadata are stored under the host-provided plugin data directory, scoped to the project/workspace. Pi owns the conversation transcripts. Interrupted records remain visible; there is no durable job resumption or automatic retention policy. The source text is sent to the pirate's model provider. This is trusted agent code, not a tool sandbox.

## Installation and activation

Install from **Settings → Pi packages → Available packages** on the target machine, then explicitly enable **Captain's Log** in **Settings → PI WEB plugins**. The package ships compiled. Manual installation can use `pi install /absolute/path/to/dist/pi-packages/captains-log` with the target machine's Pi profile.

Restart the target session daemon manually when safe, **from outside its hosted sessions**, then reload the browser. A web/API restart alone cannot activate the backend. Existing sessions need `/reload` to load an updated native companion. Project-scoped packages require normal project trust.

Disabling the PI WEB plugin controls its panel/backend, not its native extension. Remove the Pi package to remove both resource declarations; saved conversations and plugin data are retained. The older Workspace Reviews example has a separate plugin ID and must be disabled or removed separately.
