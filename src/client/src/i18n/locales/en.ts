import type { MessageCatalog } from "../types";

export const en = {
  "common.reload": "Reload",
  "language.auto": "Auto",
  "language.english": "English",
  "language.simplifiedChinese": "简体中文",
  "language.label": "Language",
  "language.description": "Choose the interface language. Auto follows your browser language and falls back to English.",
  "settings.generalDescription": "Gateway server fields edit this local gateway. File access and upload defaults edit {targetLabel}.",
  "settings.languagePreference": "Language preference",
  "settings.languagePreferenceDescription": "This setting applies to the browser interface only. It does not change system prompts or remote machine configuration.",
  "settings.generalConfiguration": "General configuration",
} as const satisfies MessageCatalog;
