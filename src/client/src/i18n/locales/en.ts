import type { MessageCatalog } from "../types";

/** Core namespace default dictionary. Keys are `${namespace}.${localKey}`. */
export const en = {
  "core.common.reload": "Reload",
  "core.language.auto": "Auto",
  "core.language.english": "English",
  "core.language.label": "Language",
  "core.language.description": "Choose the interface language. Auto follows your browser language and falls back to English.",
  "core.language.unavailable": "{label} (unavailable)",
  "core.settings.generalDescription": "Gateway server fields edit this local gateway. File access and upload defaults edit {targetLabel}.",
  "core.settings.languagePreference": "Language preference",
  "core.settings.languagePreferenceDescription": "This setting applies to the browser interface only. It does not change system prompts or remote machine configuration.",
  "core.settings.generalConfiguration": "General configuration",
} as const satisfies MessageCatalog;
