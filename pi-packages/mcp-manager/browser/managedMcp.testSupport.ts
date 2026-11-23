import type { ManagedMcpView } from "../shared.js";

export function managedMcpView(overrides: Partial<ManagedMcpView> = {}): ManagedMcpView {
  return {
    globalConfigPath: "/home/fixture/.pi/agent/mcp-manager/config.json",
    projectConfigPath: "/workspace/.pi/mcp-manager.json",
    projectTrusted: true, globalWritable: true, projectWritable: true, sessionWritable: true,
    servers: [
      { name: "docs", description: "Documentation server", definitionScope: "global", enabled: { global: true, project: false, session: false }, effectiveEnabled: true },
      { name: "project-tools", definitionScope: "project", enabled: { global: false, project: false, session: false }, effectiveEnabled: false },
      { name: "native", definitionScope: "global", enabled: { global: false, project: false, session: false }, effectiveEnabled: false, nativeConflict: true },
    ],
    issues: [], revision: "revision-1", ...overrides,
  };
}
