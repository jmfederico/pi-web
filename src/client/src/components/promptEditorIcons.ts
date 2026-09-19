import { svg, type TemplateResult } from "lit";
import type { ThinkingGauge } from "../../../shared/thinkingLevels";

// Hand-rolled inline icons matching the project's stroke style
// (viewBox 0 0 24 24, fill none, stroke currentColor, round caps/joins).
// See tabIcons.ts for the established convention.

export function renderAttachIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 11.5 12.5 19a4 4 0 0 1-5.66-5.66l7.07-7.07a2.5 2.5 0 0 1 3.54 3.54l-7.07 7.07a1 1 0 0 1-1.42-1.42l6.37-6.36"></path>
    </svg>
  `;
}

export function renderSendIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 3 13.5 21l-2-8.5L3 10.5Z"></path>
      <path d="M21 3 11.5 12.5"></path>
    </svg>
  `;
}

export function renderQueueIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h11"></path>
      <path d="M4 12h7"></path>
      <path d="M4 17h7"></path>
      <path d="m15 14 5 3-5 3z"></path>
    </svg>
  `;
}

export function renderSteerIcon(): TemplateResult {
  // Steer and send are both "do this now"; the queue icon carries the "later" distinction.
  return renderSendIcon();
}

export function renderCaretIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  `;
}

export function renderStopIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon prompt-action-icon-filled" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2"></rect>
    </svg>
  `;
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
