import type { SafeTunnelAccountAccessNotice } from "../../shared/safeTunnelTypes.js";

/**
 * Normalized provider-neutral account-access denial. The Control API adapter
 * validates its bounded browser-safe fields before this crosses into local
 * orchestration.
 */
export class SafeTunnelAccountAccessError extends Error {
  constructor(readonly notice: SafeTunnelAccountAccessNotice) {
    super(notice.message);
    this.name = "SafeTunnelAccountAccessError";
  }
}
