import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareRelayDispatch, type PreparedRelayDispatch } from "../relayDispatch.js";
import { requireRelayLeg } from "../relayIdentity.js";

const DispatchParams = Type.Object({
  packet: Type.String({ description: "Saved Relay packet directory containing charter.md, status.md and log.md. Relative paths resolve in the target workspace." }),
  leg: Type.String({
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$",
    description: 'String identity of the leg being dispatched, for example "2" or "R1-a". Numbers and other non-string values are rejected, not converted.',
  }),
  cwd: Type.Optional(Type.String({ description: "Target workspace of the same registered project. Omit to use this session's workspace." })),
  model: Type.Optional(Type.String({ description: 'Exact provider/model-id override. Set only when instructed to select a specific model or choose an appropriate one; otherwise omit to inherit.' })),
  thinkingLevel: Type.Optional(Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
    description: "Thinking-level override. Set only when instructed to select a level or choose an appropriate one; otherwise omit to inherit. Pi clamps valid levels to the selected model.",
  })),
}, { additionalProperties: false });

interface DispatchResult {
  sessionId: string;
  cwd: string;
  model?: string;
}

export default function relayExtension(pi: ExtensionAPI): void {
  pi.registerTool(defineTool<typeof DispatchParams, DispatchResult>({
    name: "dispatch_relay",
    label: "Dispatch Relay",
    description: "Start one independent Relay leg from its saved packet. Requires explicit human approval before initial dispatch. Save the actual baton in status.md first; this tool generates the handover and records Relay identity itself. There is no free-form prompt parameter. Use once as the final operational action, then report a brief summary.",
    promptSnippet: "dispatch_relay: dispatch one Relay leg from its saved packet; approval before initial dispatch; final operational action",
    exposure: "model-only",
    parameters: DispatchParams,
    prepareArguments(args) {
      const leg: unknown = typeof args === "object" && args !== null && !Array.isArray(args) ? Reflect.get(args, "leg") : undefined;
      requireRelayLeg(leg);
      // Guard identity before Pi's coercion. Its schema validation checks the
      // remaining fields next; retain the raw object, including unknown keys.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return args as Static<typeof DispatchParams>;
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const prepared = await prepareRelayDispatch(ctx.cwd, params);
      signal?.throwIfAborted();
      const result = await dispatchThroughHost(pi, prepared, {
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.thinkingLevel === undefined ? {} : { thinkingLevel: params.thinkingLevel }),
      });
      const modelNote = result.model === undefined ? "" : ` using model ${result.model}`;
      return {
        content: [{ type: "text", text: `Started Relay ${JSON.stringify(prepared.identity.relayName)} leg ${prepared.identity.leg} as independent session ${result.sessionId} in ${result.cwd}${modelNote}. The saved packet is the handover.` }],
        details: result,
      };
    },
  }));
}

/** Documented generic in-process host protocol; unavailable hosts reject before dispatch. */
async function dispatchThroughHost(pi: Pick<ExtensionAPI, "events">, prepared: PreparedRelayDispatch, overrides: object): Promise<DispatchResult> {
  let accepted: Promise<DispatchResult> | undefined;
  pi.events.emit("pi-web:session-dispatch:v1", {
    input: { prompt: prepared.prompt, cwd: prepared.cwd, name: prepared.name, metadata: prepared.metadata, ...overrides },
    accept: (result: Promise<DispatchResult>) => { accepted = result; },
  });
  if (accepted === undefined) throw new Error("Relay dispatch requires PI WEB's session dispatch bridge. Update PI WEB and restart the session daemon when safe; no session was dispatched.");
  return accepted;
}
