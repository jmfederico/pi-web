import type { PiWebPluginV5 } from "@jmfederico/pi-web/plugin-api";

interface Check {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly durationMs?: number;
}

interface CheckResults {
  readonly checks: readonly Check[];
  readonly durationMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDuration(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isCheck(value: unknown): value is Check {
  return isRecord(value)
    && typeof value["name"] === "string" && value["name"].trim() !== ""
    && (value["status"] === "passed" || value["status"] === "failed")
    && isDuration(value["durationMs"]);
}

function parseResults(value: unknown): CheckResults | undefined {
  if (!isRecord(value) || !Array.isArray(value["checks"]) || !isDuration(value["durationMs"])) return undefined;
  const checks: unknown[] = value["checks"];
  if (!checks.every(isCheck)) return undefined;
  return value["durationMs"] === undefined ? { checks } : { checks, durationMs: value["durationMs"] };
}

function parseCommand(args: unknown): string | undefined {
  let value: unknown = args;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return isRecord(value) && typeof value["command"] === "string" && value["command"].trim() !== ""
    ? value["command"]
    : undefined;
}

function duration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

const plugin = {
  apiVersion: 5,
  name: "Example transcript renderer",
  requires: [{
    pluginId: "pi-web",
    id: "transcript-rendering",
    version: 1,
    parse(value: unknown): object {
      if (!isRecord(value)) throw new Error("Transcript rendering v1 is unavailable");
      return value;
    },
  }],
  activate: ({ html }) => ({
    contributions: {
      stylesheets: [{
        id: "checks.styles",
        url: new URL("./styles.css", import.meta.url).href,
      }],
      transcriptRenderers: [
        {
          id: "checks-wrapper",
          target: "tool",
          resolve: (toolName, next) => {
            if (toolName !== "example_checks") return next();
            const downstream = next();
            if (!downstream) return undefined;
            return {
              render(input) {
                const body = downstream.render(input);
                return body === undefined ? undefined : html`
                  <div class="example-checks-wrapper">
                    <p class="example-checks-attribution">Rendered by the example plugin</p>
                    ${body}
                  </div>
                `;
              },
            };
          },
        },
        {
          id: "checks",
          target: "tool",
          resolve: (toolName, next) => {
            if (toolName !== "example_checks") return next();
            return {
              render: ({ entry }) => {
                const results = parseResults(entry.details);
                const inProgress = entry.status === "pending" || entry.status === "running";
                // Missing details are normal before a result; malformed supplied details retain the default view.
                if (!results && (!inProgress || entry.details !== undefined)) return undefined;
                const command = parseCommand(entry.args);
                const output = entry.resultText;
                const failed = results?.checks.filter((check) => check.status === "failed").length ?? 0;
                const passed = (results?.checks.length ?? 0) - failed;
                const state = inProgress ? entry.status : entry.status === "error" || failed > 0 ? "failed" : "passed";
                return html`
                  <section class="example-checks-card" data-state=${state} aria-label="Workspace checks">
                    <header class="example-checks-header">
                      <div>
                        <p class="example-checks-eyebrow">CHECK RESULTS</p>
                        <h3 class="example-checks-heading">Workspace checks</h3>
                      </div>
                      <span class="example-checks-badge" data-status=${state}>
                        ${inProgress ? entry.status === "pending" ? "Pending" : "Running" : state === "failed" ? "Failed" : "Passed"}
                      </span>
                    </header>
                    <div class="example-checks-summary">
                      <span>${inProgress ? "Waiting for check results…" : `${passed} passed · ${failed} failed`}</span>
                      ${results?.durationMs !== undefined ? html`<span class="example-checks-duration">${duration(results.durationMs)} total</span>` : undefined}
                    </div>
                    ${results ? html`
                      <ul class="example-checks-list" aria-label="Checks">
                        ${results.checks.map((check) => html`
                          <li class="example-checks-row">
                            <span class="example-checks-mark" data-status=${check.status} aria-hidden="true">${check.status === "passed" ? "✓" : "×"}</span>
                            <span class="example-checks-name">${check.name}</span>
                            <span class="example-checks-status" data-status=${check.status}>${check.status === "passed" ? "Passed" : "Failed"}</span>
                            <span class="example-checks-duration">${check.durationMs !== undefined ? duration(check.durationMs) : "—"}</span>
                          </li>
                        `)}
                      </ul>
                      ${results.checks.length === 0 ? html`<p class="example-checks-empty">No checks reported.</p>` : undefined}
                    ` : undefined}
                    ${command !== undefined || output !== undefined ? html`
                      <details class="example-checks-details">
                        <summary>Command and output</summary>
                        <div class="example-checks-source">
                          ${command !== undefined ? html`<p class="example-checks-label">Command</p><pre>${command}</pre>` : undefined}
                          ${output !== undefined ? html`<p class="example-checks-label">Output</p><pre>${output}</pre>` : undefined}
                        </div>
                      </details>
                    ` : undefined}
                  </section>
                `;
              },
            };
          },
        },
        {
          id: "task-notice",
          target: "custom-message",
          customType: "example.task-notice",
          render: ({ entry }) => {
            const details = entry.details;
            if (!isRecord(details) || typeof details["title"] !== "string" || details["title"].trim() === ""
              || (details["status"] !== "completed" && details["status"] !== "failed")
              || typeof details["summary"] !== "string") return undefined;
            return html`
              <section class="example-checks-notice" data-state=${details["status"]} aria-label=${details["title"]}>
                <span class="example-checks-notice-mark" aria-hidden="true">${details["status"] === "completed" ? "✓" : "×"}</span>
                <div class="example-checks-notice-body">
                  <div class="example-checks-notice-heading">
                    <h3 class="example-checks-heading">${details["title"]}</h3>
                    <span class="example-checks-status" data-status=${details["status"]}>${details["status"] === "completed" ? "Completed" : "Failed"}</span>
                  </div>
                  <p class="example-checks-notice-summary">${details["summary"]}</p>
                </div>
              </section>
            `;
          },
        },
      ],
    },
  }),
} satisfies PiWebPluginV5;

export default plugin;
