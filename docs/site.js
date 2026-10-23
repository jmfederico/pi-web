const animatedHomePage = document.querySelector(".home-page");

if (animatedHomePage !== null) {
  const skipIntroAnimation = () => {
    animatedHomePage.classList.add("intro-skipped");
  };

  if (window.scrollY !== 0) {
    skipIntroAnimation();
  } else {
    window.addEventListener("scroll", skipIntroAnimation, { passive: true, once: true });
  }
}

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

const screenshotCarousels = document.querySelectorAll("[data-demo-carousel]");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function setupScreenshotCarousel(carousel) {
  const gallery = carousel.querySelector("[data-demo-gallery]");
  const image = gallery?.querySelector("img");
  const caption = carousel.querySelector("[data-demo-theme-caption]");
  const controls = carousel.querySelector("[data-demo-controls]");
  const rotationButton = carousel.querySelector("[data-demo-rotation]");
  const colorsButton = carousel.querySelector("[data-demo-colors]");
  const deviceButtons = Array.from(carousel.querySelectorAll("[data-demo-device]"));
  const deviceCaption = carousel.querySelector("[data-demo-device-caption]");
  const dots = Array.from(carousel.querySelectorAll("[data-demo-dot]"));
  const trigger = carousel.querySelector("[data-demo-lightbox-trigger]");
  const lightbox = carousel.querySelector("[data-demo-lightbox]");
  const lightboxImage = carousel.querySelector("[data-demo-lightbox-image]");
  const lightboxCaption = carousel.querySelector("[data-demo-lightbox-caption]");
  const lightboxCloseButton = carousel.querySelector("[data-demo-lightbox-close]");

  if (!gallery || !image || !caption || !controls || !rotationButton || !colorsButton || dots.length === 0) return;

  const devices = {
    desktop: { name: "Desktop", width: 1440, height: 900, description: "Chat beside workspace file preview." },
    tablet: { name: "Tablet", width: 1024, height: 768, description: "The same session on a wider touch screen." },
    mobile: { name: "Mobile", width: 390, height: 844, description: "Session chat on a pocket-sized screen." },
  };
  let activeDevice = "desktop";
  let inverted = false;
  let availableDots = [];
  let activeIndex = 0;
  let rotationEnabled = !reducedMotionQuery.matches;
  let hovered = gallery.matches(":hover");
  let timer;

  function updateRotation() {
    window.clearTimeout(timer);
    const rotationLabel = rotationEnabled ? "Pause rotation" : "Resume rotation";
    rotationButton.setAttribute("aria-label", rotationLabel);
    rotationButton.title = rotationLabel;
    rotationButton.dataset.paused = String(!rotationEnabled);
    gallery.setAttribute("aria-live", rotationEnabled ? "off" : "polite");
    if (!rotationEnabled || hovered || gallery.contains(document.activeElement) || document.hidden || lightbox?.open) return;
    timer = window.setTimeout(() => selectTheme(activeIndex + 1), 3000);
  }

  function selectTheme(index) {
    activeIndex = (index + availableDots.length) % availableDots.length;
    const dot = availableDots[activeIndex];
    const theme = dot.dataset.demoTheme;
    const device = devices[activeDevice];
    image.src = `assets/pi-web-${activeDevice}-${dot.dataset.demoDot}.png`;
    image.width = device.width;
    image.height = device.height;
    image.alt = `PI WEB ${activeDevice} workspace in ${theme} theme. ${device.description}`;
    caption.textContent = theme;
    if (deviceCaption) deviceCaption.textContent = `${device.name} — ${device.description}`;
    dots.forEach((choice) => {
      choice.setAttribute("aria-current", choice === dot ? "true" : "false");
    });
    updateRotation();
  }

  carousel.querySelector("[data-demo-prev]")?.addEventListener("click", () => selectTheme(activeIndex - 1));
  carousel.querySelector("[data-demo-next]")?.addEventListener("click", () => selectTheme(activeIndex + 1));
  dots.forEach((dot) => dot.addEventListener("click", () => {
    const index = availableDots.indexOf(dot);
    if (index !== -1) selectTheme(index);
  }));

  function updateThemePair() {
    const pageIsLight = activeTheme() === "light";
    const scheme = pageIsLight !== inverted ? "light" : "dark";
    availableDots = dots.filter((dot) => dot.dataset.demoScheme === scheme);
    dots.forEach((dot) => { dot.hidden = !availableDots.includes(dot); });
    const label = scheme === "light" ? "Show dark screenshots" : "Show light screenshots";
    colorsButton.setAttribute("aria-label", label);
    colorsButton.title = label;
    selectTheme(activeIndex);
  }

  deviceButtons.forEach((button) => button.addEventListener("click", () => {
    const device = button.dataset.demoDevice;
    if (!Object.hasOwn(devices, device)) return;
    activeDevice = device;
    deviceButtons.forEach((choice) => choice.setAttribute("aria-pressed", String(choice === button)));
    selectTheme(activeIndex);
  }));

  colorsButton.addEventListener("click", () => {
    inverted = !inverted;
    updateThemePair();
  });
  const pageThemeObserver = new MutationObserver(updateThemePair);
  pageThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  systemPrefersLight.addEventListener("change", updateThemePair);

  rotationButton.addEventListener("click", () => {
    rotationEnabled = !rotationEnabled;
    updateRotation();
  });

  gallery.addEventListener("mouseenter", () => {
    hovered = true;
    updateRotation();
  });
  gallery.addEventListener("mouseleave", () => {
    hovered = false;
    updateRotation();
  });
  gallery.addEventListener("focusin", updateRotation);
  gallery.addEventListener("focusout", (event) => {
    if (!gallery.contains(event.relatedTarget)) {
      // focusout fires before activeElement changes.
      window.queueMicrotask(updateRotation);
    }
  });
  document.addEventListener("visibilitychange", updateRotation);
  reducedMotionQuery.addEventListener("change", () => {
    if (reducedMotionQuery.matches) rotationEnabled = false;
    updateRotation();
  });

  function closeLightbox() {
    if (!lightbox) return;
    if (typeof lightbox.close === "function") lightbox.close();
    else {
      lightbox.removeAttribute("open");
      trigger?.focus({ preventScroll: true });
      updateRotation();
    }
  }

  trigger?.addEventListener("click", () => {
    if (!lightbox || !lightboxImage) return;
    // Snapshot the selected theme; rotation never changes an open preview.
    lightboxImage.src = image.src;
    lightboxImage.alt = image.alt;
    if (lightboxCaption) lightboxCaption.textContent = `${caption.textContent} — ${deviceCaption?.textContent ?? devices[activeDevice].description}`;
    if (typeof lightbox.showModal === "function") lightbox.showModal();
    else lightbox.setAttribute("open", "");
    lightboxCloseButton?.focus({ preventScroll: true });
    updateRotation();
  });
  lightboxCloseButton?.addEventListener("click", closeLightbox);
  lightbox?.addEventListener("click", (event) => {
    if (event.target === lightbox) closeLightbox();
  });
  lightbox?.addEventListener("close", () => {
    lightboxImage?.removeAttribute("src");
    trigger?.focus({ preventScroll: true });
    updateRotation();
  });

  if (trigger) trigger.disabled = false;
  controls.hidden = false;
  updateThemePair();
}

for (const carousel of screenshotCarousels) {
  setupScreenshotCarousel(carousel);
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
