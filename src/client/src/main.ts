import { initializeLocale } from "./i18n/locale";
import { setMissingMessageKeyDiagnostics } from "./i18n/resources";
import "./components/PiWebApp";

initializeLocale();

if (import.meta.env.DEV) {
  // Development-only diagnostics for missing keys; production falls back silently.
  setMissingMessageKeyDiagnostics((locale, key) => {
    console.warn(`Missing PI WEB interface message for ${locale}: ${key}`);
  });
}
