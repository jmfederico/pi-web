import { expect, test } from "@playwright/test";

const cases = (["ordinary", "activity"] as const).flatMap((kind) => [-4, 4].map((delta) => ({ kind, delta })));

for (const { kind, delta } of cases) {
  const direction = delta < 0 ? "up" : "down";
  test(`${kind}, ${direction}: every painted reading frame follows only explicit scroll input`, async ({ page }, testInfo) => {
    await page.goto("/scroll-stability.html");
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    // Unwindowed production rendering establishes the measurement contract;
    // the same inputs then exercise the opt-in mounting behavior.
    for (const windowed of [false, true]) {
      const ready = await page.evaluate(({ kind, windowed }) => window.scrollStabilityFixture.start(kind, windowed), { kind, windowed });
      const trace = await page.evaluate(({ rest, delta }) => window.scrollStabilityFixture.trace(50, delta, rest), { delta, rest: kind === "ordinary" && windowed ? 20 : 0 });
      let previous = trace.initial.offset;
      if (previous === null) throw new Error("Missing initial anchor geometry");
      let travel = 0;
      let maxReversal = 0;
      let maxStepError = 0;
      let maxError = 0;
      for (const sample of trace.samples) {
        if (sample.offset === null) { maxError = Infinity; continue; }
        const movement = sample.offset - previous;
        maxError = Math.max(maxError, Math.abs(sample.offset - sample.expectedOffset));
        maxReversal = Math.max(maxReversal, movement * Math.sign(delta));
        maxStepError = Math.max(maxStepError, Math.abs(movement + sample.input));
        travel += Math.abs(movement);
        previous = sample.offset;
      }
      const metrics = { maxError, maxReversal, maxStepError, travel };
      const label = `${kind}-${direction}-${windowed ? "windowed" : "baseline"}`;
      await testInfo.attach(`${label}-trace`, { body: JSON.stringify({ ready, ...trace, metrics }, null, 2), contentType: "application/json" });
      console.log(`${label}: ${JSON.stringify(metrics)}`);
      expect.soft(ready.retained, label).toBe(300);
      expect.soft(trace.samples.every((sample) => sample.sameNode), `${label}: fixed DOM anchor`).toBe(true);
      expect.soft(trace.samples.every((sample) => sample.offset !== null && sample.bottom !== null && sample.offset < 480 + 600 && sample.bottom > -600), `${label}: anchor stays within overscan`).toBe(true);
      expect.soft(trace.samples.every((sample) => Math.abs(sample.inputAfter - sample.inputBefore - sample.input) <= 0.01), `${label}: exact unclamped CSS-pixel inputs`).toBe(true);
      expect.soft(maxError, `${label}: continuous anchor error`).toBeLessThanOrEqual(1);
      expect.soft(maxReversal, `${label}: no reverse travel`).toBeLessThanOrEqual(1);
      expect.soft(maxStepError, `${label}: no extra per-frame travel`).toBeLessThanOrEqual(1);
      expect.soft(travel, `${label}: no extra accumulated travel (including rest)`).toBeLessThanOrEqual(201);
    }
  });
}
