import type { PiWebConfigResponse } from "../api";
import type { ChatSessionWarningRow } from "./chat/SessionWarnings";
import { generalMessages as messages } from "./settings/settingsGeneralMessages";

/** Gateway snapshots only: drafts and selected-machine config never decide these notices. */
export function hostValidationNotices(config: PiWebConfigResponse | undefined, onOpenSettings: () => void): readonly ChatSessionWarningRow[] {
  if (config === undefined) return [];
  const desired = config.effectiveConfig.hostValidation ?? "pending";
  const active = config.activeHostValidation;
  const pending = desired === "pending";
  const restart = active === undefined ? desired === "enabled" : (active === "enabled") !== (desired === "enabled");
  if (!pending && !restart) return [];
  return [{
    id: "gateway-host-validation",
    severity: "warning",
    severityClass: "session-warning warning",
    source: "PI WEB",
    message: [
      pending ? messages.t("hostValidationDecision") : undefined,
      restart ? messages.t("hostValidationRestart", { desired, active: active ?? "unknown" }) : undefined,
    ].filter((message) => message !== undefined).join(" "),
    action: { label: messages.t("hostValidationSettings"), run: onOpenSettings },
  }];
}
