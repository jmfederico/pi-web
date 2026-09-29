import { Type } from "typebox";
import { KNOWN_THINKING_LEVELS } from "../../shared/thinkingLevels.js";
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
  /** Explicit override or dispatching session's inherited thinking level (pi clamps it to the spawned model's capabilities). */
  thinkingLevel?: SpawnSessionThinkingLevel;
}

export interface SpawnSessionToolDeps {
  spawn(input: SpawnSessionInvocation): Promise<SpawnSessionResult>;
}

type SpawnSessionToolDetails = SpawnSessionResult;

const SpawnSessionParams = Type.Object({
  thinkingLevel: Type.Optional(Type.Enum(KNOWN_THINKING_LEVELS, {
    description: "Thinking level override for the new session. Set this field only when instructed to use a specific thinking level or to choose an appropriate one. Otherwise omit it to inherit this session's thinking level. An unknown value is rejected; valid levels are clamped to the selected model's capabilities.",
  })),
  prompt: Type.String({
    description: "The first instruction to send to the newly created session. The new session runs independently; you do not receive its output.",
  }),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the new session. Must be a workspace (worktree, or root) of the same project as this session. Defaults to this session's working directory.",
  })),
  model: Type.Optional(Type.String({
    description: 'Model override for the new session, as an exact "provider/model-id". Set this field only when instructed to use a specific model or to choose an appropriate one. Otherwise omit it to inherit this session\'s model. An unknown value is rejected.',
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
      const thinkingLevel = params.thinkingLevel ?? ctx.thinkingLevel;
      const result = await deps.spawn({
        spawningCwd,
        spawningSessionId: ctx.sessionManager.getSessionId(),
        prompt: params.prompt,
        cwd: params.cwd,
        ...(ctx.model === undefined ? {} : { model: ctx.model }),
        ...(params.model === undefined ? {} : { modelSpec: params.model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      });
      const modelNote = result.model === undefined ? "" : ` using model ${result.model}`;
      return {
        content: [{ type: "text", text: `Started independent session ${result.sessionId} in ${result.cwd}${modelNote}.` }],
        details: result,
      };
    },
  });
}
