const themeButtons = document.querySelectorAll("[data-theme-toggle]");
const themeStorageKey = "pi-web-theme";
const systemPrefersLight = window.matchMedia("(prefers-color-scheme: light)");

function storedThemeMode() {
  const theme = window.localStorage.getItem(themeStorageKey);
  return theme === "light" || theme === "dark" || theme === "auto" ? theme : "auto";
}

function activeTheme() {
  return document.documentElement.dataset.theme === "light" || document.documentElement.dataset.theme === "dark"
    ? document.documentElement.dataset.theme
    : systemPrefersLight.matches
      ? "light"
      : "dark";
}

function applyThemeMode(mode) {
  if (mode === "light" || mode === "dark") {
    document.documentElement.dataset.theme = mode;
  } else {
    delete document.documentElement.dataset.theme;
  }
  window.localStorage.setItem(themeStorageKey, mode);
  updateThemeButtons(mode);
}

function updateThemeButtons(mode = storedThemeMode()) {
  const active = activeTheme();
  for (const button of themeButtons) {
    button.dataset.theme = mode;
    button.dataset.activeTheme = active;
    const icon = button.querySelector("[data-theme-icon]");
    const label = button.querySelector("[data-theme-label]");
    if (mode === "auto") {
      button.setAttribute("aria-label", `Theme: Auto (${active}). Click to use dark theme.`);
      if (icon !== null) icon.textContent = "◐";
      if (label !== null) label.textContent = "Auto";
    } else if (mode === "light") {
      button.setAttribute("aria-label", "Theme: Light. Click to use automatic theme.");
      if (icon !== null) icon.textContent = "☀";
      if (label !== null) label.textContent = "Light";
    } else {
      button.setAttribute("aria-label", "Theme: Dark. Click to use light theme.");
      if (icon !== null) icon.textContent = "☾";
      if (label !== null) label.textContent = "Dark";
    }
  }
}

updateThemeButtons();
systemPrefersLight.addEventListener("change", () => {
  if (storedThemeMode() === "auto") updateThemeButtons("auto");
});

for (const button of themeButtons) {
  button.addEventListener("click", () => {
    const currentMode = storedThemeMode();
    const nextTheme = currentMode === "auto" ? "dark" : currentMode === "dark" ? "light" : "auto";
    applyThemeMode(nextTheme);
  });
}

function setupPageContentsNavigation() {
  const contents = document.querySelector(".toc, .reference-nav");
  if (contents === null || typeof window.HTMLDialogElement?.prototype.showModal !== "function") return;

  const compactLayout = window.matchMedia("(max-width: 1100px)");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "docs-toc-toggle";
  toggle.innerHTML = '<span aria-hidden="true">☷</span> On this page';
  toggle.setAttribute("aria-haspopup", "dialog");
  toggle.setAttribute("aria-controls", "docs-page-contents");
  toggle.setAttribute("aria-expanded", "false");

  const dialog = document.createElement("dialog");
  dialog.id = "docs-page-contents";
  dialog.className = "docs-toc-dialog";
  dialog.setAttribute("aria-labelledby", "docs-page-contents-title");
  dialog.innerHTML = '<div class="docs-toc-dialog-header"><strong id="docs-page-contents-title">On this page</strong><button type="button" aria-label="Close page contents" autofocus>✕</button></div>';
  const closeButton = dialog.querySelector("button");
  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Page sections");
  // Derive the popup from the existing TOC so both navigation surfaces stay in sync.
  for (const source of contents.querySelectorAll('a[href^="#"]')) {
    const link = document.createElement("a");
    link.setAttribute("href", source.getAttribute("href"));
    link.textContent = source.textContent;
    link.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      dialog.close();
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (target !== null) {
        // Continue keyboard navigation at the destination, not back at the floating button.
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
      // Keep native fragment navigation, history, and scroll-margin behavior.
    });
    nav.append(link);
  }
  dialog.append(nav);
  document.body.append(toggle, dialog);
  document.body.classList.add("docs-has-contents");

  toggle.addEventListener("click", () => {
    if (!compactLayout.matches) return;
    for (const link of nav.querySelectorAll("a")) {
      if (link.hash === window.location.hash) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
    dialog.showModal();
    toggle.setAttribute("aria-expanded", "true");
  });
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => toggle.setAttribute("aria-expanded", "false"));
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      dialog.close();
    }
  });
  compactLayout.addEventListener("change", () => {
    if (!compactLayout.matches && dialog.open) dialog.close();
  });
}

setupPageContentsNavigation();

const versionSwitchLinks = document.querySelectorAll(".version-switcher-option");

// Carry the current anchor across the stable/dev switch so cross-links land on the
// same section of the counterpart page. Mutating href on click also covers
// open-in-new-tab; context-menu "copy link" keeps the hashless canonical URL.
for (const link of versionSwitchLinks) {
  link.addEventListener("click", () => {
    if (window.location.hash === "") return;
    const url = new URL(link.href);
    url.hash = window.location.hash;
    link.href = url.toString();
  });
}

const copyButtons = document.querySelectorAll("[data-copy]");

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const targetSelector = button.getAttribute("data-copy");
    const target = targetSelector === null ? null : document.querySelector(targetSelector);
    const text = target?.textContent?.replace(/^\s*\$ /gm, "").trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1400);
    } catch {
      button.textContent = "Select code";
    }
  });
}
