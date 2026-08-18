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
  const controls = carousel.querySelector("[data-demo-controls]");
  const previousButton = carousel.querySelector("[data-demo-prev]");
  const nextButton = carousel.querySelector("[data-demo-next]");
  const dots = Array.from(carousel.querySelectorAll("[data-demo-dot]"));
  const slides = Array.from(carousel.querySelectorAll("[data-demo-slide]"));
  const lightbox = carousel.querySelector("[data-demo-lightbox]");
  const lightboxImage = carousel.querySelector("[data-demo-lightbox-image]");
  const lightboxCaption = carousel.querySelector("[data-demo-lightbox-caption]");
  const lightboxCloseButton = carousel.querySelector("[data-demo-lightbox-close]");
  const lightboxTriggers = Array.from(carousel.querySelectorAll("[data-demo-lightbox-trigger]"));

  if (gallery === null || slides.length === 0) return;

  let updateQueued = false;

  function galleryHasOverflow() {
    return gallery.scrollWidth > gallery.clientWidth + 4;
  }

  function closestSlideIndex() {
    const galleryRect = gallery.getBoundingClientRect();
    const galleryCenter = galleryRect.left + galleryRect.width / 2;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    slides.forEach((slide, index) => {
      const rect = slide.getBoundingClientRect();
      const distance = Math.abs(rect.left + rect.width / 2 - galleryCenter);
      if (distance < closestDistance) {
        closestIndex = index;
        closestDistance = distance;
      }
    });

    return closestIndex;
  }

  function scrollToSlide(index) {
    const slide = slides[index];
    if (slide === undefined) return;

    slide.scrollIntoView({
      behavior: reducedMotionQuery.matches ? "auto" : "smooth",
      block: "nearest",
      inline: "start",
    });
  }

  function closeLightbox() {
    if (lightbox === null) return;

    if (typeof lightbox.close === "function" && lightbox.open) {
      lightbox.close();
    } else {
      lightbox.removeAttribute("open");
    }
  }

  function openLightbox(trigger) {
    const image = trigger.querySelector("img");
    if (image === null || lightbox === null || lightboxImage === null) return;

    const figure = trigger.closest("figure");
    const captionParts = Array.from(figure?.querySelectorAll("figcaption strong, figcaption span") ?? [])
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    const caption = captionParts.length > 0 ? captionParts.join(" — ") : "PI WEB screenshot";

    lightboxImage.src = image.currentSrc || image.src;
    lightboxImage.alt = image.alt;
    if (lightboxCaption !== null) lightboxCaption.textContent = caption;

    if (typeof lightbox.showModal === "function") {
      lightbox.showModal();
    } else {
      lightbox.setAttribute("open", "");
    }

    lightboxCloseButton?.focus({ preventScroll: true });
  }

  function updateControls() {
    const overflow = galleryHasOverflow();
    const activeIndex = closestSlideIndex();
    const atStart = gallery.scrollLeft <= 2;
    const atEnd = gallery.scrollLeft + gallery.clientWidth >= gallery.scrollWidth - 2;

    carousel.dataset.overflow = overflow ? "true" : "false";
    gallery.tabIndex = overflow ? 0 : -1;
    if (controls !== null) controls.hidden = !overflow;
    if (previousButton !== null) previousButton.disabled = !overflow || atStart;
    if (nextButton !== null) nextButton.disabled = !overflow || atEnd;

    dots.forEach((dot, index) => {
      dot.setAttribute("aria-current", index === activeIndex ? "true" : "false");
    });
  }

  function queueUpdateControls() {
    if (updateQueued) return;
    updateQueued = true;
    window.requestAnimationFrame(() => {
      updateQueued = false;
      updateControls();
    });
  }

  previousButton?.addEventListener("click", () => {
    scrollToSlide(Math.max(closestSlideIndex() - 1, 0));
  });

  nextButton?.addEventListener("click", () => {
    scrollToSlide(Math.min(closestSlideIndex() + 1, slides.length - 1));
  });

  dots.forEach((dot) => {
    const targetIndex = Number.parseInt(dot.getAttribute("data-demo-dot") ?? "", 10);
    if (Number.isNaN(targetIndex)) return;

    dot.addEventListener("click", () => {
      scrollToSlide(targetIndex);
    });
  });

  lightboxTriggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      openLightbox(trigger);
    });
  });

  lightboxCloseButton?.addEventListener("click", closeLightbox);

  lightbox?.addEventListener("click", (event) => {
    if (event.target === lightbox) closeLightbox();
  });

  lightbox?.addEventListener("close", () => {
    lightboxImage?.removeAttribute("src");
  });

  gallery.addEventListener("scroll", queueUpdateControls, { passive: true });
  window.addEventListener("resize", queueUpdateControls);

  if ("ResizeObserver" in window) {
    const resizeObserver = new window.ResizeObserver(queueUpdateControls);
    resizeObserver.observe(gallery);
    slides.forEach((slide) => resizeObserver.observe(slide));
  }

  updateControls();
}

for (const carousel of screenshotCarousels) {
  setupScreenshotCarousel(carousel);
}

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
