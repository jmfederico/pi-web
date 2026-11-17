import { Type } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";

const Parameters = Type.Object({});

export type CheckSelfArchive = (sessionId: string) => Promise<void>;

export function createArchiveSelfToolDefinition(check?: CheckSelfArchive) {
  return defineTool<typeof Parameters, { archiveSelf: true }>({
    name: "archive_self",
    exposure: "model-only",
    label: "Archive this session",
    description: "End this run and request archival of this session and its tracked subsessions, preserving their transcripts. Requires idle descendants; reports blocking sessions otherwise. Independent sessions and scheduled tasks stay unchanged. New conversation work cancels the request.",
    promptSnippet: "archive_self: end the run and archive this session and its tracked subsessions",
    promptGuidelines: [
      "Use archive_self only when the user clearly requests archiving this session, such as ‘archive yourself,’ ‘archive this session,’ or equivalent wording that explicitly conveys archival.",
      "Finish any outcome reports and final summary first, then call archive_self alone and last. It ends the run; the result acknowledges the request, not completed archival.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await check?.(ctx.sessionManager.getSessionId());
      return {
        content: [{ type: "text", text: "Archival requested for this session and its tracked subsessions. Archival proceeds after this run settles if the whole tree is idle." }],
        details: { archiveSelf: true },
        terminate: true,
      };
    },
  });
}
