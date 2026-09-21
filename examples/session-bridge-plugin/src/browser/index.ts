import type { PiWebPlugin, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { isReview, type Review } from "./protocol.js";

interface PanelState { reviews: Review[]; selected?: Review; busy: boolean; status: string }
const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Workspace Reviews",
  activate({ html }) {
    const states = new Map<string, PanelState>();
    let disposed = false;
    const stateFor = (context: WorkspacePanelContext) => {
      const key = JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
      let state = states.get(key);
      if (!state) { state = { reviews: [], busy: false, status: "Refresh to load saved reviews, or start a new review." }; states.set(key, state); }
      return state;
    };
    async function perform(context: WorkspacePanelContext, operation: "start" | "list" | "read", id?: string): Promise<void> {
      const state = stateFor(context);
      if (state.busy) return;
      state.busy = true;
      state.status = operation === "start" ? "Starting review…" : "Loading reviews…";
      context.host.requestRender();
      try {
        if (!context.peer?.request) throw new Error("Package backend unavailable on the selected machine");
        const result: unknown = await context.peer.request(operation, id ?? null);
        if (operation === "list") {
          if (!Array.isArray(result) || !result.every(isReview)) throw new Error("Invalid review list");
          state.reviews = result;
          const selectedId = state.selected?.id ?? result[0]?.id;
          if (selectedId !== undefined && result.some((review) => review.id === selectedId)) {
            const selected: unknown = await context.peer.request("read", selectedId);
            if (!isReview(selected)) throw new Error("Invalid saved review");
            state.selected = selected;
            state.reviews = state.reviews.map((review) => review.id === selected.id ? { ...selected, text: "" } : review);
          } else delete state.selected;
          state.status = `${String(result.length)} saved review(s).`;
        } else {
          if (!isReview(result)) throw new Error("Invalid review response");
          state.selected = result;
          if (operation === "start") state.reviews = [result, ...state.reviews];
          else state.reviews = state.reviews.map((review) => review.id === result.id ? { ...result, text: "" } : review);
          state.status = operation === "start" ? "Review admitted. Refresh for progress; follow its conversation in Sessions." : "Review loaded.";
        }
      } catch (error) { state.status = error instanceof Error ? error.message : String(error); }
      finally { state.busy = false; if (!disposed) context.host.requestRender(); }
    }
    return {
      contributions: {
        workspacePanels: [{
          id: "reviews", title: "Reviews",
          render(context) {
            const state = stateFor(context);
            const disabled = state.busy || !context.peer?.request;
            const index = state.reviews.findIndex((review) => review.id === state.selected?.id);
            const cycle = (delta: number) => {
              const next = state.reviews[(index + delta + state.reviews.length) % state.reviews.length];
              if (next) void perform(context, "read", next.id);
            };
            return html`<section class="viewer">
              <p>Review uncommitted changes in this workspace in a new Pi session. No fixes requested. Uses your configured model.</p>
              <button ?disabled=${disabled || state.reviews.some((review) => review.status === "running")} @click=${() => { void perform(context, "start"); }}>Start review</button>
              <button ?disabled=${disabled} @click=${() => { void perform(context, "list"); }}>Refresh reviews</button>
              <p role="status" aria-live="polite">${state.status}</p>
              <label>Saved reviews <select aria-label="Saved reviews" ?disabled=${disabled || !state.reviews.length}
                @change=${(event: Event) => {
                  if (event.target instanceof HTMLSelectElement && event.target.value !== "") void perform(context, "read", event.target.value);
                }}>
                <option value="" ?selected=${!state.selected}>Choose a review</option>
                ${state.reviews.map((review) => html`<option value=${review.id} ?selected=${review.id === state.selected?.id}>${review.createdAt} — ${review.status}</option>`)}
              </select></label>
              <button ?disabled=${disabled || state.reviews.length < 2} @click=${() => { cycle(-1); }}>Previous review</button>
              <button ?disabled=${disabled || state.reviews.length < 2} @click=${() => { cycle(1); }}>Next review</button>
              ${state.selected ? html`<h3>${state.selected.status}</h3>
                <p>Session: ${state.selected.sessionId || "Not created yet; refresh shortly"}</p>
                <pre style="white-space: pre-wrap; overflow-wrap: anywhere;">${state.selected.text}</pre>` : html`<p>No review selected.</p>`}
            </section>`;
          },
        }],
      },
      dispose() { disposed = true; states.clear(); },
    };
  },
};
export default plugin;
