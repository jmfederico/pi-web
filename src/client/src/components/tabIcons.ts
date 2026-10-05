import { renderHeroIcon } from "./heroicons";
import { html, type TemplateResult } from "lit";

export function renderNavigationMenuIcon(): TemplateResult {
  return renderHeroIcon("bars-3");
}

export type AppTabBuiltinIcon = "navigation" | "chat";
export type AppTabIcon = AppTabBuiltinIcon | TemplateResult;

export function renderAppTabIcon(icon: AppTabIcon): TemplateResult {
  if (typeof icon !== "string") return html`<span class="tab-custom-icon" aria-hidden="true">${icon}</span>`;
  return renderBuiltinTabIcon(icon);
}

export function renderBuiltinTabIcon(icon: AppTabBuiltinIcon): TemplateResult {
  return renderHeroIcon(icon === "navigation" ? "list-bullet" : "chat-bubble-left-ellipsis", "tab-icon");
}
