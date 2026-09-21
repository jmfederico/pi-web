import type { ReactiveController, ReactiveControllerHost } from "lit";
import { localeStore } from "./locale";
import type { MessageKey } from "./translate";
import type { TranslationParams } from "./types";

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

  setPreference(preference: "auto" | "en" | "zh-CN"): void {
    localeStore.setPreference(preference);
  }

  t<Key extends MessageKey>(key: Key, params?: TranslationParams<Key, typeof import("./locales/en").en>): string {
    return localeStore.translate(key, params);
  }
}
