import type { PiWebConfigResponse } from "../api";
import type { ChatSessionWarningRow } from "./chat/SessionWarnings";
import { restartMessages } from "../restartMessages";
import { generalMessages as messages } from "./settings/settingsGeneralMessages";

/** Gateway snapshots only: drafts and selected-machine config never decide these notices. */
export function hostAccessNotices(config: PiWebConfigResponse | undefined, onOpenSettings: () => void, onRestartWeb: () => void): readonly ChatSessionWarningRow[] {
  if (config === undefined) return [];
  const desired = config.effectiveConfig.hostAccess ?? null;
  const active = config.activeHostAccess;
  const pending = desired === null;
  // null is known undecided, not equivalent to an explicit opt-out. An older
  // API's missing snapshot cannot confirm that a saved policy is running.
  const restart = active === undefined ? desired !== null : !sameHostAccess(desired, active);
  if (!pending && !restart) return [];
  return [{
    id: "gateway-host-access",
    severity: "warning",
    severityClass: "session-warning warning",
    source: "PI WEB",
    message: [
      pending ? messages.t("hostAccessDecision") : undefined,
      restart ? messages.t("hostAccessRestart") : undefined,
    ].filter((message) => message !== undefined).join(" "),
    action: pending
      ? { label: messages.t("hostAccessSettings"), run: onOpenSettings }
      : { label: restartMessages.t("restartWeb"), run: onRestartWeb },
  }];
}

function sameHostAccess(left: PiWebConfigResponse["activeHostAccess"], right: PiWebConfigResponse["activeHostAccess"]): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  if (left.mode !== right.mode) return false;
  return left.mode === "any" || (right.mode === "restricted" && left.hosts.length === right.hosts.length && left.hosts.every((host, index) => host === right.hosts[index]));
}
