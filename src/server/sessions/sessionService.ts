import type {
  SavedPromptAttachment,
  SessionBulkArchiveResponse,
  SessionBulkDeleteArchivedResponse,
  SessionBulkMutationRef,
  SessionNotificationCatalogSnapshot,
  SessionNotificationDismissAllRequest,
  SessionNotificationDismissRequest,
  SessionNotificationInboxSnapshot,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
} from "../../shared/apiTypes.js";
import type {
  ClientArchiveSessionsResponse,
  ClientCommand,
  ClientCommandResult,
  ClientMessagePage,
  ClientSession,
  ClientSessionCleanupExecuteResponse,
  ClientSessionCleanupPreviewResponse,
  ClientSessionModel,
  ClientSessionRef,
  ClientSessionStatus,
  ClientSessionTreeNavigateRequest,
  ClientSessionTreeNavigateResult,
  ClientThinkingLevel,
  SessionStreamSnapshot,
} from "../types.js";
import type { NormalizedSessionCleanupRequest } from "./sessionCleanup.js";

export type SessionRouteRef = ClientSessionRef;
export type SessionRouteLookup = string | SessionRouteRef;

/**
 * Route-facing session contract for PI WEB's HTTP/WebSocket API.
 *
 * Keep transport concerns separate from the bundled Pi SDK implementation so
 * routes remain testable. Pi-specific lifecycle hooks such as auth-change
 * handling and daemon shutdown stay on the concrete service.
 */
export interface SessionRouteService {
  list(cwd: string): Promise<ClientSession[]>;
  start(cwd: string): Promise<ClientSession>;
  messages(ref: SessionRouteLookup, page?: { before?: number; limit?: number }): Promise<unknown[] | ClientMessagePage>;
  status(ref: SessionRouteLookup): Promise<ClientSessionStatus>;
  streamSnapshot(ref: SessionRouteLookup): Promise<SessionStreamSnapshot>;
  notificationCatalog(): SessionNotificationCatalogSnapshot | Promise<SessionNotificationCatalogSnapshot>;
  unreadCatalog(): Promise<SessionUnreadCatalogSnapshot>;
  acknowledgeUnread(sessionId: string, request: SessionUnreadAcknowledgeRequest): Promise<SessionUnreadCatalogSnapshot>;
  notificationInbox(ref: SessionRouteRef): SessionNotificationInboxSnapshot | Promise<SessionNotificationInboxSnapshot>;
  dismissNotification(ref: SessionRouteRef, request: Omit<SessionNotificationDismissRequest, "cwd">): SessionNotificationInboxSnapshot | Promise<SessionNotificationInboxSnapshot>;
  dismissAllNotifications(ref: SessionRouteRef, request: Omit<SessionNotificationDismissAllRequest, "cwd">): SessionNotificationInboxSnapshot | Promise<SessionNotificationInboxSnapshot>;
  clearQueue(ref: SessionRouteLookup): Promise<ClientSessionStatus>;
  dismissWarning(ref: SessionRouteLookup, dismissId: string): Promise<ClientSessionStatus>;
  availableModels(ref: SessionRouteLookup): Promise<ClientSessionModel[]>;
  setModel(ref: SessionRouteLookup, provider: string, modelId: string): Promise<ClientSessionStatus>;
  cycleModel(ref: SessionRouteLookup, direction: "forward" | "backward"): Promise<ClientSessionStatus>;
  availableThinkingLevels(ref: SessionRouteLookup): Promise<ClientThinkingLevel[]>;
  setThinkingLevel(ref: SessionRouteLookup, level: string): Promise<ClientSessionStatus>;
  cycleThinkingLevel(ref: SessionRouteLookup): Promise<ClientSessionStatus>;
  commands(ref: SessionRouteLookup): Promise<ClientCommand[]>;
  prompt(ref: SessionRouteLookup, text: unknown, streamingBehavior?: unknown, attachments?: unknown): Promise<void>;
  saveAttachments(ref: SessionRouteLookup, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]>;
  cleanupPreview(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupPreviewResponse>;
  cleanup(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupExecuteResponse>;
  archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse>;
  deleteArchivedMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkDeleteArchivedResponse>;
  shell(ref: SessionRouteLookup, text: string): Promise<void>;
  runCommand(ref: SessionRouteLookup, text: string): Promise<ClientCommandResult>;
  respondToCommand(ref: SessionRouteLookup, requestId: string, value: string): Promise<ClientCommandResult>;
  navigateTree(ref: SessionRouteLookup, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult>;
  abort(ref: SessionRouteLookup): Promise<void>;
  stop(ref: SessionRouteLookup): void | Promise<void>;
  archive(ref: SessionRouteLookup): Promise<void>;
  archiveTree(ref: SessionRouteLookup): Promise<ClientArchiveSessionsResponse>;
  restore(ref: SessionRouteLookup): Promise<void>;
  deleteArchived(ref: SessionRouteLookup): Promise<void>;
  reload(ref: SessionRouteLookup): Promise<void>;
  detachParent(ref: SessionRouteLookup): Promise<void>;
}
