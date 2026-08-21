import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PiWebPluginSafeStart } from "../../shared/apiTypes.js";
import type { PiWebPluginCatalog } from "../piWebPluginCatalog.js";

/**
 * Pi prompt-template and skill directories that enabled plugins contribute to
 * every session. Paths are absolute plugin package directories following pi's
 * package conventions: `prompts/*.md` for prompt templates and
 * `skills/<name>/SKILL.md` for skills.
 */
export interface PluginSessionResourcePaths {
  readonly promptTemplatePaths: readonly string[];
  readonly skillPaths: readonly string[];
}

const NO_SESSION_RESOURCES: PluginSessionResourcePaths = {
  promptTemplatePaths: [],
  skillPaths: [],
};

/**
 * Resolve the Pi resources enabled plugins ship for sessions, honoring the
 * plugin lifecycle's daemon-startup enablement snapshot: resources appear in
 * sessions created after the daemon start that observed the desired state, and
 * a safe start withholds them exactly as it withholds server entries.
 *
 * Only bundled and local plugins contribute this way. Plugins delivered as Pi
 * packages already get their `prompts/` and `skills/` directories loaded by
 * pi's own package resolution, so injecting them here would only produce
 * duplicate-name collision diagnostics.
 *
 * Plugin resources are fallback defaults in pi's load order: a project or user
 * prompt template or skill with the same name shadows the plugin's.
 */
export async function resolvePluginSessionResourcePaths(
  catalog: Pick<PiWebPluginCatalog, "snapshot">,
  options: { safeStart?: PiWebPluginSafeStart } = {},
): Promise<PluginSessionResourcePaths> {
  if (options.safeStart === "none") return NO_SESSION_RESOURCES;
  const { plugins } = await catalog.snapshot();
  const promptTemplatePaths: string[] = [];
  const skillPaths: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    if (plugin.scope === "user" || plugin.scope === "project") continue;
    if (options.safeStart === "bundled-only" && plugin.scope !== "bundled") continue;
    const promptsDir = join(plugin.packageRoot, "prompts");
    if (isDirectory(promptsDir)) promptTemplatePaths.push(promptsDir);
    const skillsDir = join(plugin.packageRoot, "skills");
    if (isDirectory(skillsDir)) skillPaths.push(skillsDir);
  }
  return { promptTemplatePaths, skillPaths };
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
