import type { Workspace } from "../api";

/**
 * Navigation the host honors from a workspace provider's metadata.
 *
 * Provider metadata is otherwise free-form and only plugins read it. These two keys are
 * the exception: the host itself acts on them, so they are validated here and documented
 * in `docs/plugins.md` rather than trusted as-is.
 */
export interface ProviderNavigation {
  /** The provider's project is an implied single context, not a choice worth a section. */
  hideProjects: boolean;
  /** Name for the workspace section while one of this provider's workspaces is selected. */
  workspacesTitle?: string;
}

const NO_PROVIDER_NAVIGATION: ProviderNavigation = { hideProjects: false };

export function providerNavigation(workspace: Workspace | undefined): ProviderNavigation {
  const raw: unknown = workspace?.provider?.metadata?.["navigation"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NO_PROVIDER_NAVIGATION;
  const hideProjects = Reflect.get(raw, "hideProjects") === true;
  const title: unknown = Reflect.get(raw, "workspacesTitle");
  const workspacesTitle = typeof title === "string" ? title.trim() : "";
  return workspacesTitle === "" ? { hideProjects } : { hideProjects, workspacesTitle };
}
