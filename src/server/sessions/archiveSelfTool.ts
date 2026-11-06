import { Type } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";

const Parameters = Type.Object({});

export function createArchiveSelfToolDefinition() {
  return defineTool<typeof Parameters, { archiveSelf: true }>({
    name: "archive_self",
    exposure: "model-only",
    label: "Archive this session",
    description: "End this run and request archival of this session once it is idle. Preserves the transcript; does not archive other sessions or change scheduled tasks. New conversation work cancels the request.",
    promptSnippet: "archive_self: end the run and archive this session",
    promptGuidelines: [
      "Use archive_self according to the user's archival instructions; decide whether the outcome needs review before calling it.",
      "Finish any outcome reports and final summary first, then call archive_self alone and last. It ends the run; the result acknowledges the request, not completed archival.",
    ],
    parameters: Parameters,
    // eslint-disable-next-line @typescript-eslint/require-await -- Tool execution is promise-shaped.
    async execute() {
      return {
        content: [{ type: "text", text: "Archival requested. This session will be archived once the run is idle." }],
        details: { archiveSelf: true },
        terminate: true,
      };
    },
  });
}
