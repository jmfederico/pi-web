import type { ReactiveController, ReactiveControllerHost } from "lit";
import { localeStore } from "./locale";
import type { LanguageOption } from "./locale";
import type { LanguagePreference } from "./types";
import type { CoreMessageKey, TranslationParams } from "./types";
import type { en } from "./locales/en";

export class LocaleController implements ReactiveController {
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    this.unsubscribe = localeStore.subscribe(() => { this.host.requestUpdate(); });
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  get locale() {
    return localeStore.getLocale();
  }

  get preference() {
    return localeStore.getPreference();
  }

  get languageOptions(): readonly LanguageOption[] {
    return localeStore.getLanguageOptions();
  }

  setPreference(preference: LanguagePreference): void {
    localeStore.setPreference(preference);
  }

  t<Key extends CoreMessageKey>(key: Key, params?: TranslationParams<Key, typeof en>): string;
  t(key: string, params?: Record<string, string | number>): string;
  t(key: string, params?: Record<string, string | number>): string {
    return localeStore.translate(key, params);
  }
}
