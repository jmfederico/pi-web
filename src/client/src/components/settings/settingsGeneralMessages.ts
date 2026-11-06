import { localization } from "../../localization/browser";
import source from "./settingsGeneral.messages";
import { SettingsConfigValidationError } from "./settingsConfigDraft";

export const generalMessages = localization.registerMessages("core.settingsGeneral", source);

export function generalConfigError(error: unknown): string {
  if (!(error instanceof SettingsConfigValidationError)) return error instanceof Error ? error.message : String(error);
  const validation = error.validation;
  switch (validation.kind) {
    case "hostValidationList": return generalMessages.t("hostValidationListRequired");
    case "port": return generalMessages.t("invalidPort", { min: 1, max: 65535 });
    case "externalPath": return generalMessages.t("externalPath", { value: validation.value });
    case "folderRelative": return generalMessages.t("folderRelative", { field: validation.field });
    case "folderTraversal": return generalMessages.t("folderTraversal", { field: validation.field });
  }
}
