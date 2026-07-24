import { describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import { templateEventHandlerAfterMarker } from "../templateInspection.testSupport";

// Escape hatch per the testing guide: these cases verify Lit event wiring on
// the `.chat` scroller (`@touchstart`/`@touchend`/`@touchcancel`) whose only
// observable effect is when `whenScrollIdle()` resolves. Vitest runs with no
// DOM environment here, so direct handler extraction anchored to the stable
// `@touch...=` markup is proportionate. The scroll-idle state machine itself is
// unit-tested in scrollIdle.test.ts.
describe("ChatView touch scroll-idle wiring", () => {
  const touchEvent = Object.assign(new Event("touchstart"), { touches: [] });

  function touchHandler(view: ChatView, marker: string): (event: typeof touchEvent) => void {
    return templateEventHandlerAfterMarker<typeof touchEvent>(view.render(), marker);
  }

  it("defers whenScrollIdle while a touch gesture is active and settles after touchend", async () => {
    const view = new ChatView();
    touchHandler(view, "@touchstart=")(touchEvent);

    let resolved = false;
    void view.whenScrollIdle().then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(resolved).toBe(false);

    touchHandler(view, "@touchend=")(touchEvent);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(resolved).toBe(true);
  });

  it("settles whenScrollIdle after a touchcancel", async () => {
    const view = new ChatView();
    touchHandler(view, "@touchstart=")(touchEvent);
    touchHandler(view, "@touchcancel=")(touchEvent);

    let resolved = false;
    void view.whenScrollIdle().then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(resolved).toBe(true);
  });
});
