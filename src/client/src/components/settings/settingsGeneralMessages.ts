import { localization } from "../../localization/browser";
import type { PiWebConfigValues } from "../../api";
import source from "./settingsGeneral.messages";
import { SettingsConfigValidationError } from "./settingsConfigDraft";

export const generalMessages = localization.registerMessages("core.settingsGeneral", source);

export function formatHostAccess(policy: PiWebConfigValues["hostAccess"] | null): string {
  if (policy === undefined) return generalMessages.t("hostAccessUnknown");
  if (policy === null) return generalMessages.t("hostAccessUndecided");
  if (policy.mode === "any") return generalMessages.t("hostAccessAny");
  return generalMessages.t("hostAccessList", { hosts: policy.hosts.length ? localization.list(policy.hosts) : generalMessages.t("noHosts") });
}

export function generalConfigError(error: unknown): string {
  if (!(error instanceof SettingsConfigValidationError)) return error instanceof Error ? error.message : String(error);
  const validation = error.validation;
  switch (validation.kind) {
    case "port": return generalMessages.t("invalidPort", { min: 1, max: 65535 });
    case "externalPath": return generalMessages.t("externalPath", { value: validation.value });
    case "folderRelative": return generalMessages.t("folderRelative", { field: validation.field });
    case "folderTraversal": return generalMessages.t("folderTraversal", { field: validation.field });
  }
}
