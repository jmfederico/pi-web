// Safe service-manager probe: no daemon startup, state ownership or SDK loading.
import { checkTerminalPrerequisites } from "./server/diagnostics/terminalPrerequisites.js";
import { piWebRuntimeIdentity } from "./shared/piWebRuntime.js";

if (process.argv.includes("--terminal")) {
  const readiness = await checkTerminalPrerequisites();
  if (!readiness.ok) {
    for (const line of readiness.lines) console.error(line);
    process.exitCode = 1;
  }
}
if (process.exitCode !== 1) console.log(piWebRuntimeIdentity().name);
