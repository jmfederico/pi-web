import type { ContentRendererContribution, ContentRenderRequest } from "../../../plugin-api";

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

/** Code-unit order, independent of browser locale or registration order. */
export function compareContentRenderers(a: RegisteredContentRenderer, b: RegisteredContentRenderer): number {
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  return compare(a.sourcePluginId ?? a.pluginId, b.sourcePluginId ?? b.pluginId)
    || compare(a.localId, b.localId)
    || compare(a.pluginId, b.pluginId);
}

export function contentRendererMatches(renderer: ContentRendererContribution, request: ContentRenderRequest): boolean {
  const language = request.language?.trim().split(/\s/u)[0]?.toLowerCase();
  const fileName = request.filePath?.split(/[\\/]/u).at(-1)?.toLowerCase();
  return (language !== undefined && renderer.languages?.includes(language) === true)
    || (fileName !== undefined && renderer.fileExtensions?.some((extension) => fileName.endsWith(`.${extension}`)) === true);
}

export function snapshotContentRenderer(contribution: ContentRendererContribution): ContentRendererContribution {
  if (typeof contribution.render !== "function") throw new Error("Content renderer must have a synchronous render callback");
  const renderMode: unknown = contribution.renderMode;
  if (renderMode !== undefined && renderMode !== "manual" && renderMode !== "automatic") throw new Error("Content renderer renderMode must be manual or automatic");
  const selectors = (values: readonly string[] | undefined): readonly string[] => {
    if (values === undefined) return Object.freeze([]);
    if (!Array.isArray(values) || values.some((value: unknown) => typeof value !== "string" || !/^[a-z0-9][a-z0-9_+.-]*$/iu.test(value))) {
      throw new Error("Content renderer selectors must be non-empty language names or extensions without a leading dot");
    }
    return Object.freeze([...new Set(values.map((value: string) => value.toLowerCase()))]);
  };
  const languages = selectors(contribution.languages);
  const fileExtensions = selectors(contribution.fileExtensions);
  if (languages.length + fileExtensions.length === 0) throw new Error("Content renderer must declare a selector");
  return Object.freeze({ id: contribution.id, languages, fileExtensions, renderMode: contribution.renderMode ?? "manual", render: contribution.render.bind(contribution) });
}
