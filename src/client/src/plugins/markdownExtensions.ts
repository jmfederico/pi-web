import type { MarkdownExtensionContribution } from "../../../plugin-api";
export { snapshotMarkdownExtension } from "../formatting/markdownEngine";

export interface RegisteredMarkdownExtension extends MarkdownExtensionContribution {
  readonly pluginId: string;
  readonly machineId?: string;
  readonly sourcePluginId?: string;
  readonly lifetime: AbortSignal;
}
