// TEMP(happy-dom-selectionchange): see docs/temporary-code.md
// happy-dom dispatches `selectionchange` synchronously while a Selection changes.
// Browsers queue one task per document instead, coalescing changes made in the same
// task. CodeMirror 6.43.14 and later react to the synchronous event by re-entering
// their own view update, which browsers never do. This mirrors the upstream fix
// (happy-dom PR #2325) for the test window's document in every happy-dom test file.
// happy-dom builds per-window document classes, so the instance is patched rather
// than the global Document prototype. Node-environment files have no document.

export function queueSelectionChangeEvents(target: Document): void {
  const dispatch = target.dispatchEvent.bind(target);
  // happy-dom re-enters dispatchEvent for each event phase; let queued events through.
  const queued = new WeakSet<Event>();
  let scheduled = false;
  Object.defineProperty(target, "dispatchEvent", {
    configurable: true,
    writable: true,
    value: (event: Event): boolean => {
      if (event.type !== "selectionchange" || queued.has(event)) return dispatch(event);
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          const queuedEvent = new Event("selectionchange");
          queued.add(queuedEvent);
          dispatch(queuedEvent);
        });
      }
      return true;
    },
  });
}

if (typeof document !== "undefined") queueSelectionChangeEvents(document);
