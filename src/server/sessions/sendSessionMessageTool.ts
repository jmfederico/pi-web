import { Type } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";

export interface SendSessionMessageInvocation {
  sendingCwd: string;
  /** Internal sender identity from the live extension context, not tool arguments. */
  sendingSessionId: string;
  sessionId: string;
  message: string;
}

export interface SendSessionMessageResult {
  sessionId: string;
  delivery: "started" | "queued";
}

export interface SendSessionMessageToolDeps {
  crossProjectSessionMessages?: boolean;
  send(input: SendSessionMessageInvocation): Promise<SendSessionMessageResult>;
}

export function createSendSessionMessageToolDefinition(spawningCwd: string, deps: SendSessionMessageToolDeps) {
  const scope = deps.crossProjectSessionMessages === true
    ? "across all projects on the same machine"
    : "in the same project on the same machine";
  const parameters = Type.Object({
    sessionId: Type.String({
      description: `Target session id ${scope}; no parent-child relationship is required.`,
    }),
    message: Type.String({
      description: "Message to deliver as an instruction in the target session's conversation.",
    }),
  });
  return defineTool<typeof parameters, SendSessionMessageResult>({
    name: "send_session_message",
    label: "Send session message",
    description: `Send a message to any session ${scope}. An idle session starts a run; a busy session receives it as steering at the next safe agent boundary. A message may wake a stopped session. This creates no parent-child relationship, provides no access to results, and grants no control over the target session.`,
    promptSnippet: "send_session_message: start an idle session or steer a busy session; no relationship, results, or control",
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await deps.send({
        sendingCwd: spawningCwd,
        sendingSessionId: ctx.sessionManager.getSessionId(),
        sessionId: params.sessionId,
        message: params.message,
      });
      const text = result.delivery === "started"
        ? `Message accepted for session ${result.sessionId}; requested a new run.`
        : `Message accepted for steering in session ${result.sessionId}; delivery waits for a safe agent boundary.`;
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
