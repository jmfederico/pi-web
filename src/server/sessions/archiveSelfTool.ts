import { Type } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";

const Parameters = Type.Object({});

export type CheckSelfArchive = (sessionId: string) => Promise<void>;

export function createArchiveSelfToolDefinition(check?: CheckSelfArchive) {
  return defineTool<typeof Parameters, { archiveSelf: true }>({
    name: "archive_self",
    exposure: "model-only",
    label: "Archive this session",
    description: "Request archival of this session and its tracked subsessions, making them unavailable for new work while preserving their transcripts. Use only for an explicit, unequivocal user request to archive this session. Requires idle descendants; reports blocking sessions otherwise. Independent sessions stay unchanged.",
    promptSnippet: "archive_self: request archival of this session and its tracked subsessions, making them unavailable for new work",
    promptGuidelines: [
      "Use archive_self only for an explicit, unequivocal user request to archive this session.",
      "Called alone, a successful archive_self call ends the current run immediately. The result confirms an archival request; archival occurs after the run settles and makes this session and its tracked subsessions unavailable for new work.",
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
