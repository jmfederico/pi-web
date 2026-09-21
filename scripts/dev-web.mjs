import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startDevelopmentProcess, superviseDevelopmentProcesses } from "./dev-processes.mjs";

const require = createRequire(import.meta.url);

export function runDevelopmentWeb({ env = process.env, launch = startDevelopmentProcess, signals = process, stop } = {}) {
  const childEnv = { ...env, PI_WEB_BROWSER_URL: env.PI_WEB_BROWSER_URL || "http://127.0.0.1:8505" };
  return superviseDevelopmentProcesses((add, stopped) => {
    const builder = add(launch(resolve("scripts/build-plugins.mjs"), ["--watch"], childEnv, true));
    let apiStarted = false;
    builder.on("message", (message) => {
      if (stopped() || apiStarted || message?.type !== "plugin-build-ready") return;
      apiStarted = true;
      add(launch(require.resolve("tsx/cli"), ["watch", "src/server/index.ts"], childEnv));
    });
  }, { signals, ...(stop === undefined ? {} : { stop }) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runDevelopmentWeb();
}
