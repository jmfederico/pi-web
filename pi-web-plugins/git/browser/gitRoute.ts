import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

const legacyDiffNamespace = "core.workspace.git";
const diffQueryKey = "diff";

export interface GitDiffRoute {
  matches(context: WorkspacePanelContext): boolean;
  read(): string | undefined;
  write(path: string | undefined, options?: { replace?: boolean }): void;
}

export function createGitDiffRoute(panelContributionId: string): GitDiffRoute {
  const namespace = panelContributionId.replaceAll(":", ".");
  const key = `${namespace}--${diffQueryKey}`;
  const legacyKey = `${legacyDiffNamespace}--${diffQueryKey}`;
  return {
    matches: routeMatchesWorkspace,
    read: () => {
      const params = new URLSearchParams(window.location.search);
      return nonEmpty(params.get(key)) ?? nonEmpty(params.get(legacyKey));
    },
    write: (path, options) => {
      const url = new URL(window.location.href);
      url.searchParams.delete(key);
      url.searchParams.delete(legacyKey);
      if (path !== undefined && path !== "") url.searchParams.set(key, path);
      commitUrl(url, options?.replace === true);
    },
  };
}

function routeMatchesWorkspace(context: WorkspacePanelContext): boolean {
  const params = new URLSearchParams(window.location.search);
  return (params.get("machine") ?? "local") === context.machine.id
    && params.get("project") === context.workspace.projectId
    && params.get("workspace") === context.workspace.id;
}

function nonEmpty(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function commitUrl(url: URL, replace: boolean): void {
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}
