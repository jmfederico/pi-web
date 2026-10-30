import { isTemplateResult } from "lit/directive-helpers.js";
import type { TranscriptRendererContribution, TranscriptRendererInput, TranscriptToolRenderer, TranscriptToolRendererInput, TranscriptToolRendererResolver } from "../../../plugin-api";
import type { PluginCapability } from "./types";

export type RegisteredTranscriptRenderer = TranscriptRendererContribution & {
  readonly pluginId: string;
  readonly localId: string;
  readonly machineId?: string;
  readonly sourcePluginId?: string;
};

/** A feature-detection capability; rendering itself is contribution-based. */
export const transcriptRenderingCapability = Object.freeze({});
export const transcriptRenderingCapabilityToken: PluginCapability = Object.freeze({
  pluginId: "pi-web", id: "transcript-rendering", version: 1,
  parse: (value: unknown) => {
    if (typeof value !== "object" || value === null) throw new Error("Transcript rendering capability v1 is unavailable");
    return value;
  },
});

/** All tool resolvers participate; only the first custom-message match participates. */
export function selectTranscriptRenderers(renderers: readonly RegisteredTranscriptRenderer[]): readonly RegisteredTranscriptRenderer[] {
  const customTypes = new Set<string>();
  return Object.freeze(renderers.filter((renderer) => {
    if (renderer.target === "tool") return true;
    if (customTypes.has(renderer.customType)) return false;
    customTypes.add(renderer.customType);
    return true;
  }));
}

/** Resolve discovery-ordered tool contributions; the caller supplies the base, otherwise the tail resolves undefined. */
export function resolveTranscriptToolRenderer(
  toolName: string,
  registeredRenderers: readonly RegisteredTranscriptRenderer[],
  base: () => TranscriptToolRenderer | undefined = () => undefined,
): TranscriptToolRenderer | undefined {
  const tools = registeredRenderers.filter((renderer) => renderer.target === "tool");
  const resolve = (index: number): TranscriptToolRenderer | undefined => {
    const contribution = tools[index];
    return contribution === undefined ? base() : contribution.resolve(toolName, () => resolve(index + 1));
  };
  return resolve(0);
}

function rejectAsyncResult(value: unknown, message: string): void {
  if (((typeof value === "object" && value !== null) || typeof value === "function") && "then" in value && typeof value.then === "function") {
    // Consume rejected async results before the synchronous host reports the contract violation.
    void Promise.resolve(value).catch(() => undefined);
    throw new Error(message);
  }
}

function validateToolRenderer(value: unknown): TranscriptToolRenderer | undefined {
  if (value === undefined) return undefined;
  rejectAsyncResult(value, "Transcript tool resolver must return synchronously");
  if (isToolRenderer(value)) return value;
  throw new Error("Transcript tool resolver must return an object with a render callback or undefined");
}

function isToolRenderer(value: unknown): value is TranscriptToolRenderer {
  return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

export function snapshotTranscriptRenderer(contribution: TranscriptRendererContribution, lifetime: AbortSignal): TranscriptRendererContribution {
  const wrap = <Input extends TranscriptRendererInput,>(render: (input: Input) => import("lit").TemplateResult | undefined) => (input: Input) => {
    const signal = AbortSignal.any([input.signal, lifetime]);
    if (signal.aborted) return undefined;
    return render({ ...input, signal, fail: (error: unknown) => { if (!signal.aborted) input.fail(error); } });
  };
  if (contribution.target === "tool") {
    if (typeof contribution.resolve !== "function") throw new Error("Transcript tool renderer must have a synchronous resolve callback");
    const resolve = contribution.resolve.bind(contribution);
    const id = contribution.id;
    const snapshotResolve: TranscriptToolRendererResolver = (toolName, next) => {
      if (lifetime.aborted) return undefined;
      const delegated = new Set<TranscriptToolRenderer>();
      const renderer = validateToolRenderer(resolve(toolName, () => {
        if (lifetime.aborted) return undefined;
        const downstream = next();
        if (downstream !== undefined) delegated.add(downstream);
        return downstream;
      }));
      if (renderer === undefined || delegated.has(renderer)) return renderer;
      const render = renderer.render.bind(renderer);
      return Object.freeze({ render: wrap<TranscriptToolRendererInput>((input) => {
        const result = render(input);
        rejectAsyncResult(result, `Transcript tool renderer ${id} must return a Lit template or undefined synchronously`);
        if (result !== undefined && !isTemplateResult(result)) throw new Error(`Transcript tool renderer ${id} must return a Lit template or undefined synchronously`);
        return result;
      }) });
    };
    return Object.freeze({ id: contribution.id, target: "tool", resolve: snapshotResolve });
  }
  const target: unknown = contribution.target;
  if (target !== "custom-message") throw new Error("Transcript renderer target must be tool or custom-message");
  if (typeof contribution.customType !== "string" || contribution.customType.trim() === "") throw new Error("Transcript renderer target name must be a non-empty string");
  if (typeof contribution.render !== "function") throw new Error("Transcript renderer must have a synchronous render callback");
  return Object.freeze({ id: contribution.id, target: "custom-message", customType: contribution.customType, render: wrap(contribution.render.bind(contribution)) });
}
