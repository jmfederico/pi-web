import { ImageGalleryDialog } from "../../src/client/src/components/ImageGalleryDialog";

const gallery = new ImageGalleryDialog();
document.querySelector("main")?.append(gallery);
const images = ["First", "Second", "Third"].map((alt) => ({
  alt,
  src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="steelblue"/><path d="M0 0L800 800M800 0L0 800" stroke="white" stroke-width="20"/><text x="300" y="400" font-size="60">${alt}</text></svg>`)}`,
}));
document.querySelector("#open")?.addEventListener("click", () => { gallery.show(images, 1); });
await gallery.updateComplete;
document.body.dataset["ready"] = "true";
