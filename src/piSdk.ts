import { loadPiSdk } from "./piRuntime.js";

// Keep runtime values on the selected Pi installation; canonical imports supply
// development types without loading a second SDK at runtime.
const sdk = await loadPiSdk();

export const {
  AgentSession,
  CredentialSynchronizationError,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  Theme,
  VERSION,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createEditToolDefinition,
  createEventBus,
  createMcpExtension,
  createToolSearchExtension,
  defineTool,
  formatDimensionNote,
  hasTrustRequiringProjectResources,
  readStoredCredential,
  resizeImage,
  resolveModelScopeWithDiagnostics,
} = sdk;

export type * from "@earendil-works/pi-coding-agent";

// Value bindings above shadow wildcard type exports for classes.
export type AgentSession = import("@earendil-works/pi-coding-agent").AgentSession;
export type CredentialSynchronizationError = import("@earendil-works/pi-coding-agent").CredentialSynchronizationError;
export type DefaultPackageManager = import("@earendil-works/pi-coding-agent").DefaultPackageManager;
export type DefaultResourceLoader = import("@earendil-works/pi-coding-agent").DefaultResourceLoader;
export type ModelRuntime = import("@earendil-works/pi-coding-agent").ModelRuntime;
export type ProjectTrustStore = import("@earendil-works/pi-coding-agent").ProjectTrustStore;
export type SessionManager = import("@earendil-works/pi-coding-agent").SessionManager;
export type SettingsManager = import("@earendil-works/pi-coding-agent").SettingsManager;
export type Theme = import("@earendil-works/pi-coding-agent").Theme;
