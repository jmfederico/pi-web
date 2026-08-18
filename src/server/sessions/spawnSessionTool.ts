import { Type } from "typebox";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SpawnSessionResult {
  sessionId: string;
  cwd: string;
  /** Model the spawned session runs with, as `provider/id`; absent when unknown. */
  model?: string;
}

export type SpawnSessionModel = NonNullable<ExtensionContext["model"]>;
export type SpawnSessionThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export interface SpawnSessionInvocation {
  spawningCwd: string;
  /** Id of the dispatching session; used to resolve {@link modelSpec} against its model runtime. */
  spawningSessionId: string;
  prompt: string;
  cwd: string | undefined;
  /** Current model from the dispatching session, used as the spawned session's default. */
  model?: SpawnSessionModel;
  /** Strict `provider/model-id` requested by the dispatcher; overrides {@link model} when set. */
  modelSpec?: string;
  /** Dispatching session's current thinking level, inherited by the spawned session (pi clamps it to the spawned model's capabilities). */
  thinkingLevel?: SpawnSessionThinkingLevel;
}

export interface SpawnSessionToolDeps {
  spawn(input: SpawnSessionInvocation): Promise<SpawnSessionResult>;
}

type SpawnSessionToolDetails = SpawnSessionResult;

const SpawnSessionParams = Type.Object({
  prompt: Type.String({
    description: "The first instruction to send to the newly created session. The new session runs independently; you do not receive its output.",
  }),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the new session. Must be a workspace (worktree, or root) of the same project as this session. Defaults to this session's working directory.",
  })),
  model: Type.Optional(Type.String({
    description: 'Model for the new session, as an exact "provider/model-id" such as "anthropic/claude-sonnet-4-5". When the user references a model as #provider/model-id in their request, forward it here. An unknown value is rejected. Omit to inherit this session\'s model.',
  })),
});

/**
 * Custom tool that lets the LLM start a new, independent pi-web session and
 * deliver an initial prompt to it. The spawned session is a normal pi-web session
 * a human can open and interact with. The tool is constructed per-session, so it
 * carries the spawning session's cwd for project-scope validation.
 */
export function createSpawnSessionToolDefinition(spawningCwd: string, deps: SpawnSessionToolDeps) {
  return defineTool<typeof SpawnSessionParams, SpawnSessionToolDetails>({
    name: "spawn_session",
    label: "Spawn session",
    description: "Start a fully independent session; its transcript and results are unavailable here. Use only when the user or active workflow explicitly requests a separate session.",
    promptSnippet: "spawn_session: independent session; results unavailable here; explicit requests only",
    parameters: SpawnSessionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Failures throw: the agent loop turns the thrown message into an error
      // tool result the model sees, so the spawning agent can adapt (e.g. pick a
      // valid workspace) rather than crash.
      const result = await deps.spawn({
        spawningCwd,
        spawningSessionId: ctx.sessionManager.getSessionId(),
        prompt: params.prompt,
        cwd: params.cwd,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        ...(params.model === undefined ? {} : { modelSpec: params.model }),
        ...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
      });
      const modelNote = result.model === undefined ? "" : ` using model ${result.model}`;
      return {
        content: [{ type: "text", text: `Started independent session ${result.sessionId} in ${result.cwd}${modelNote}.` }],
        details: result,
      };
    },
  });
}
