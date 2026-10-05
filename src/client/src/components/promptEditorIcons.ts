import { renderHeroIcon } from "./heroicons";
import { svg, type TemplateResult } from "lit";
import type { ThinkingGauge } from "../../../shared/thinkingLevels";


export function renderAttachIcon(): TemplateResult {
  return renderHeroIcon("paper-clip", "prompt-action-icon");
}

export function renderSendIcon(): TemplateResult {
  return renderHeroIcon("paper-airplane", "prompt-action-icon");
}

export function renderQueueIcon(): TemplateResult {
  return renderHeroIcon("queue-list", "prompt-action-icon");
}

export function renderSteerIcon(): TemplateResult {
  // Steer and send are both "do this now"; the queue icon carries the "later" distinction.
  return renderSendIcon();
}

export function renderStopIcon(): TemplateResult {
  return renderHeroIcon("stop", "prompt-action-icon prompt-action-icon-filled", true);
}

/**
 * A gauge whose bar count comes from the available thinking levels (the non-"off"
 * levels) and whose fill reflects the current level's rank. Bars are laid out to
 * fill the 24x24 box regardless of count, so it adapts if pi changes the set.
 */
export function renderThinkingGauge(gauge: ThinkingGauge): TemplateResult {
  const total = Math.max(gauge.total, 1);
  const gap = total > 1 ? 1.2 : 0;
  const left = 3;
  const right = 21;
  const span = right - left;
  const barWidth = (span - gap * (total - 1)) / total;
  const bars = Array.from({ length: total }, (_unused, i) => {
    const x = left + i * (barWidth + gap);
    const height = 4 + ((i + 1) / total) * 12;
    const y = 20 - height;
    const active = i < gauge.filled;
    return svg`<rect class=${active ? "gauge-bar gauge-bar-active" : "gauge-bar"} x=${x} y=${y} width=${barWidth} height=${height} rx="1"></rect>`;
  });
  return svg`
    <svg class="prompt-thinking-gauge" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${bars}
    </svg>
  `;
}
