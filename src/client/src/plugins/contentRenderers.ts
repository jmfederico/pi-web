import type { ContentRendererContributionV5 as ContentRendererContribution, ContentRenderRequest } from "../../../plugin-api";

export interface RegisteredContentRenderer extends ContentRendererContribution {
  pluginId: string;
  localId: string;
  label: string;
  machineId?: string;
  sourcePluginId?: string;
}

export interface ContentRendererChoice {
  id: string;
  label: string;
  renderer: ContentRendererContribution;
}

/** Choices remain in discovery order; manual contributions never displace automatic defaults. */
export function defaultContentRendererChoice(choices: readonly ContentRendererChoice[]): ContentRendererChoice | undefined {
  for (let index = choices.length - 1; index >= 0; index--) {
    const choice = choices[index];
    if (choice?.renderer.renderMode === "automatic") return choice;
  }
  return choices[0];
}

export function contentRendererMatches(renderer: Pick<ContentRendererContribution, "languages" | "fileExtensions" | "supports">, request: ContentRenderRequest): boolean {
  const language = request.language?.trim().split(/\s/u)[0]?.toLowerCase();
  const fileName = request.filePath?.split(/[\\/]/u).at(-1)?.toLowerCase();
  const hasSelectors = (renderer.languages?.length ?? 0) + (renderer.fileExtensions?.length ?? 0) > 0;
  const matches = (language !== undefined && renderer.languages?.includes(language) === true)
    || (fileName !== undefined && renderer.fileExtensions?.some((extension) => fileName.endsWith(`.${extension}`)) === true);
  if (hasSelectors && !matches) return false;
  try {
    if (renderer.supports === undefined) return matches;
    const supported: unknown = renderer.supports(Object.freeze({ ...request }));
    // A plugin may violate the synchronous contract. Consume a rejected promise
    // as well as excluding the renderer, so eligibility never leaks a rejection.
    if (supported !== null && typeof supported === "object" && "then" in supported && typeof supported.then === "function") {
      void Promise.resolve(supported).catch((error: unknown) => { console.warn("Content renderer eligibility failed", renderer, error); });
    }
    if (typeof supported !== "boolean") throw new Error("Content renderer supports must return a boolean synchronously");
    return supported;
  } catch (error) {
    console.warn("Content renderer eligibility failed", renderer, error);
    return false;
  }
}

export function snapshotContentRenderer(contribution: ContentRendererContribution): ContentRendererContribution {
  if (typeof contribution.render !== "function") throw new Error("Content renderer must have a synchronous render callback");
  const renderMode: unknown = contribution.renderMode;
  if (renderMode !== undefined && renderMode !== "manual" && renderMode !== "automatic") throw new Error("Content renderer renderMode must be manual or automatic");
  if (contribution.supports !== undefined && typeof contribution.supports !== "function") throw new Error("Content renderer supports must be a callback");
  if (contribution.title !== undefined && (typeof contribution.title !== "string" || contribution.title.trim() === "")) throw new Error("Content renderer title must be a non-empty string");
  return Object.freeze({ id: contribution.id, ...snapshotContentSelectors(contribution, contribution.supports !== undefined),
    ...(contribution.title === undefined ? {} : { title: contribution.title }),
    ...(contribution.supports === undefined ? {} : { supports: contribution.supports.bind(contribution) }),
    renderMode: contribution.renderMode ?? "manual", render: contribution.render.bind(contribution) });
}

export function snapshotContentSelectors(contribution: Pick<ContentRendererContribution, "languages" | "fileExtensions">, allowEmpty = false): Pick<ContentRendererContribution, "languages" | "fileExtensions"> {
  const selectors = (values: readonly string[] | undefined): readonly string[] => {
    if (values === undefined) return Object.freeze([]);
    if (!Array.isArray(values) || values.some((value: unknown) => typeof value !== "string" || !/^[a-z0-9][a-z0-9_+.-]*$/iu.test(value))) {
      throw new Error("Content renderer selectors must be non-empty language names or extensions without a leading dot");
    }
    return Object.freeze([...new Set(values.map((value: string) => value.toLowerCase()))]);
  };
  const languages = selectors(contribution.languages);
  const fileExtensions = selectors(contribution.fileExtensions);
  if (!allowEmpty && languages.length + fileExtensions.length === 0) throw new Error("Content renderer must declare a selector");
  return Object.freeze({ languages, fileExtensions });
}
