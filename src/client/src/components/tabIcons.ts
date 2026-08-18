import { html, svg, type TemplateResult } from "lit";

export type AppTabBuiltinIcon = "navigation" | "chat" | "files" | "terminal";
export type AppTabIcon = AppTabBuiltinIcon | TemplateResult;

export function renderAppTabIcon(icon: AppTabIcon): TemplateResult {
  if (typeof icon !== "string") return html`<span class="tab-custom-icon" aria-hidden="true">${icon}</span>`;
  return renderBuiltinTabIcon(icon);
}

export function renderBuiltinTabIcon(icon: AppTabBuiltinIcon): TemplateResult {
  switch (icon) {
    case "navigation":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="6" cy="7" r="1.5"></circle>
          <path d="M10 7h8"></path>
          <circle cx="6" cy="12" r="1.5"></circle>
          <path d="M10 12h8"></path>
          <circle cx="6" cy="17" r="1.5"></circle>
          <path d="M10 17h8"></path>
        </svg>
      `;
    case "chat":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 5h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-6l-5 4v-4H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z"></path>
          <path d="M8 9h8"></path>
          <path d="M8 13h5"></path>
        </svg>
      `;
    case "files":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
        </svg>
      `;
    case "terminal":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3" y="5" width="18" height="14" rx="2"></rect>
          <path d="m7 10 3 3-3 3"></path>
          <path d="M12 16h5"></path>
        </svg>
      `;
  }
}
