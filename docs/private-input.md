# Private input

Save a secret to a new file from an inline PI WEB form, without putting its value in the conversation. The agent requests a destination and explains the purpose, then waits. You confirm the destination and enter the value; the agent receives only the outcome.

This is a capture workflow, not a credential store or an access-control boundary. After capture, ordinary filesystem access applies—including access by agent tools. Do not ask the agent to read the saved file to verify success.

## Install and enable

Private input ships with PI WEB as the optional package `@jmfederico/pi-web-private-input`. It is not installed automatically, and its web plugin is disabled by default.

1. Select the conversation's machine in Settings. Open **Settings → Pi packages → Available packages** and install **Private input**. Use the shipped package offered there; no separate npm publication is required.
2. Open **Settings → PI WEB plugins** and enable `private-input`.
3. When safe, manually restart that machine's session daemon, then reload the browser. Start a new conversation, or run `/reload` in an existing idle conversation to load the extension.

**Restarting the session daemon interrupts active sessions and terminals.** Check active work first and restart from outside its hosted sessions. Follow the [plugin activation guidance](plugins.md#activate-package-changes) for your deployment. A browser refresh, web/API restart, or conversation `/reload` alone does not activate the backend or changed plugin settings.

Installation and settings apply to the machine selected in Settings. Each private-input request stays bound to its conversation's machine and workspace, even if you later select another machine. The file is written on that machine, not downloaded to your browser. In a container deployment, the destination is in the container's filesystem; use persistent storage if the file must survive container replacement.

The workflow requires a supporting PI WEB-hosted session with the plugin enabled. The extension does not provide a standalone Pi TUI input form or an alternative HTTP capture service.

## Request and save a value

Ask the agent to request private input, naming the new file and its purpose without including the secret. For example:

> Request private input for a service token at `./.secrets/service-token`. The parent directory already exists. Do not read the file after saving it.

The agent calls `request_private_input` with only `destination` and `purpose`, alone and last. The request ends its run; saving, cancellation, or failure later produces a non-secret follow-up so it can continue.

1. Review the request's purpose and resolved destination. The purpose and path are conversation content, so keep secrets out of both.
2. Enter or paste the value in the inline private-input field—not the ordinary chat composer. The multiline field displays its contents; avoid screen sharing or exposing it to bystanders.
3. Select the destination confirmation checkbox, then choose **Save file**. Choose **Cancel request** instead to decline without writing a file.

Values must be nonempty text, at most 64 KiB when UTF-8 encoded. The field supports multiline input. The value submitted by the field is written as UTF-8 without trimming whitespace or appending a newline. This is text entry, not a binary-file upload; browser textareas normalize line endings, so it is not a byte-for-byte file-copy mechanism.

The input is cleared on submission, cancellation, removal of the form, request abort, or leaving the page. No draft is persisted or restored. Clearing the field does not cancel a write already admitted by the backend.

### Destination rules

- Use an absolute path, a workspace-relative path, or `~/` for the session host user's home. Files may be created inside or outside the workspace, subject to the daemon user's filesystem permissions.
- The parent directory must already exist and be accessible. Parent symlinks are resolved before showing the destination for confirmation.
- Creation is exclusive: existing files and final-path symlinks are never overwritten. Replacing an existing file requires a separate workflow.
- The backend checks the resolved destination again before writing. It requests owner-only permissions (`0600`) on systems that support Unix permission modes; platform permissions and ACLs still apply.
- Success is recorded only after writing, syncing, and closing the file. The saved file contains the value itself; it is not encrypted by this plugin.

## Check or recover an outcome

If the connection fails or the result is unclear, use **Refresh status** before taking another action. Secret submissions are never retried automatically. A disconnected browser does not necessarily stop an admitted write.

| Status | What to do |
| --- | --- |
| Waiting | The request has no recorded submission. If the conversation is idle and the extension is available, you can enter the value and confirm again, or cancel. |
| Writing | Wait and refresh status. Do not submit the value again. |
| Saved | The file was created successfully. Do not read its contents into chat to verify it. |
| Cancelled | No file was written by this request. |
| Failed | Read the failure notice. An existing destination is left untouched; an uncertain write may have left a file. |

If saving or cancellation completed but the agent did not receive the outcome, use the form's notification action when the conversation is idle. It sends only the recorded non-secret outcome; it does not write the secret again. Status refresh alone does not resume the agent.

After an interrupted write, the recovery action records an uncertain failure rather than guessing that the file was saved. Check the destination's existence and permissions without displaying its contents before requesting another capture. A file may remain if cleanup could not be confirmed. Do not blindly delete it or retry the submission.

If the form reports that the request is unavailable, check the plugin's status on the conversation's machine and wait for the conversation to become idle. Reload the extension if needed. Requests from another conversation branch cannot be reused; ask for a new request there.

## Privacy boundary

The capture workflow keeps the value out of model messages, tool arguments and results, conversation records, persisted browser drafts, and the workflow's application logs and error messages. The conversation retains the request's purpose, destination, identifiers, and outcome. Those non-secret records remain available after a browser reload; the entered value does not.

The value still passes through browser memory and PI WEB's backend transport to the destination machine, then becomes a plaintext file. For remote conversations, the gateway and remote transport are part of that trusted path. Use trusted machines, plugins, browser extensions, and a protected connection such as HTTPS. Do not configure proxies, request tracing, or external monitoring to record submission bodies.

This workflow cannot protect against browser developer tools, clipboard history, screenshots, malicious plugins, compromised hosts, or later reads of the destination file. Clearing a form is not a guarantee of secure memory erasure. File retention, backups, later use, rotation, deletion, and access enforcement are outside this feature's scope.

Disabling or removing the package does not delete captured files or conversation records. Server-plugin enablement changes require the session-daemon restart described above.
