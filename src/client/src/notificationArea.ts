import type { SessionNotificationSeverity } from "../../shared/apiTypes";

/** A display occurrence, not a second store. IDs include the source and its owner. */
export interface NotificationItem {
  id: string;
  severity: SessionNotificationSeverity;
  message: string;
  source: "browser" | "server" | "session";
  scopeLabel?: string;
  receivedAt?: string;
  truncated?: boolean;
  pending?: boolean;
  dismiss?: () => void | Promise<void>;
  retry?: () => void | Promise<void>;
}

/** Each source retains its own persistence, recovery, and dismissal semantics. */
export interface NotificationGroup {
  id: string;
  items: readonly NotificationItem[];
  discardedCount?: number;
  pending?: boolean;
  /** Captures this projection's visible items/watermark, never a future selection. */
  clear?: () => void | Promise<void>;
}
