import { beginThemeStartup, showStartupFailure } from "./themeStartup";

beginThemeStartup();
void import("./main").catch((error: unknown) => {
  console.error("PI WEB startup failed", error);
  showStartupFailure();
});
