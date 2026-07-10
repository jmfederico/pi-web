import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDimensionNote, resizeImage, type ResizedImage } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ATTACHMENT_FOLDER, attachmentsToInlineImages, saveAttachmentsToWorkspace } from "./attachmentService.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  formatDimensionNote: vi.fn(),
  resizeImage: vi.fn(),
}));

let workspace: string;
let externalDirectories: string[] = [];

beforeEach(async () => {
  vi.mocked(formatDimensionNote).mockReset();
  vi.mocked(resizeImage).mockReset();
  workspace = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
  externalDirectories = [];
});

afterEach(async () => {
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    ...externalDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  ]);
});

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const pngBase64 = pngBytes.toString("base64");

function resizedImage(overrides: Partial<ResizedImage> = {}): ResizedImage {
  return {
    data: "resized-data",
    mimeType: "image/png",
    originalWidth: 2400,
    originalHeight: 1200,
    width: 1200,
    height: 600,
    wasResized: true,
    ...overrides,
  };
}

describe("attachmentsToInlineImages", () => {
  it("resizes images, drops unresizable images, and preserves dimension notes", async () => {
    const firstInput = Buffer.from("first image");
    const droppedInput = Buffer.from("too large");
    const thirdInput = Buffer.from("third image");
    const firstResized = resizedImage({ data: "first-resized", mimeType: "image/webp" });
    const thirdResized = resizedImage({
      data: "third-resized",
      mimeType: "image/jpeg",
      originalWidth: 640,
      originalHeight: 480,
      width: 640,
      height: 480,
      wasResized: false,
    });

    vi.mocked(resizeImage)
      .mockResolvedValueOnce(firstResized)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(thirdResized);
    vi.mocked(formatDimensionNote)
      .mockReturnValueOnce("[Image dimensions changed.]")
      .mockReturnValueOnce(undefined);

    await expect(attachmentsToInlineImages([
      { kind: "image", mimeType: "image/png", data: firstInput.toString("base64"), name: "first.png" },
      { kind: "image", mimeType: "image/png", data: droppedInput.toString("base64"), name: "huge.png" },
      { kind: "image", mimeType: "image/jpeg", data: thirdInput.toString("base64"), name: "photo.jpg" },
    ])).resolves.toEqual([
      {
        image: { type: "image", data: "first-resized", mimeType: "image/webp" },
        dimensionNote: "[Image dimensions changed.]",
      },
      { image: { type: "image", data: "third-resized", mimeType: "image/jpeg" } },
    ]);

    expect(resizeImage).toHaveBeenNthCalledWith(1, firstInput, "image/png");
    expect(resizeImage).toHaveBeenNthCalledWith(2, droppedInput, "image/png");
    expect(resizeImage).toHaveBeenNthCalledWith(3, thirdInput, "image/jpeg");
    expect(formatDimensionNote).toHaveBeenNthCalledWith(1, firstResized);
    expect(formatDimensionNote).toHaveBeenNthCalledWith(2, thirdResized);
  });
});

describe("saveAttachmentsToWorkspace", () => {
  it("writes attachments into the default folder and returns relative paths", async () => {
    const fixedNow = () => new Date("2026-06-13T12:05:01.123Z");
    const saved = await saveAttachmentsToWorkspace(
      workspace,
      [
        { kind: "image", mimeType: "image/png", data: pngBase64, name: "a.png" },
        { kind: "image", mimeType: "image/webp", data: pngBase64, name: "b.webp" },
      ],
      { now: fixedNow },
    );

    expect(saved).toHaveLength(2);
    expect(saved[0]?.path.startsWith(`${DEFAULT_ATTACHMENT_FOLDER}/attachment-`)).toBe(true);
    expect(saved[0]?.path.endsWith(".png")).toBe(true);
    expect(saved[1]?.path.endsWith(".webp")).toBe(true);
    expect(saved[0]?.size).toBe(pngBytes.byteLength);

    const folderEntries = await readdir(join(workspace, ".pi-web", "attachments"));
    expect(folderEntries).toHaveLength(2);

    const firstPath = saved[0]?.path ?? "";
    const written = await readFile(join(workspace, firstPath));
    expect(written.equals(pngBytes)).toBe(true);
  });

  it("saves generic files with sanitized original filenames", async () => {
    const pdfBytes = Buffer.from("PDF bytes");
    const saved = await saveAttachmentsToWorkspace(
      workspace,
      [
        { kind: "file", mimeType: "application/pdf", data: pdfBytes.toString("base64"), name: "../Quarterly Report (final).pdf" },
        { kind: "file", mimeType: "text/plain", data: "", name: "empty.txt" },
      ],
      { now: () => new Date("2026-06-13T12:05:01.123Z") },
    );

    expect(saved[0]?.path.startsWith(`${DEFAULT_ATTACHMENT_FOLDER}/attachment-`)).toBe(true);
    expect(saved[0]?.path.endsWith("-1-Quarterly-Report-final.pdf")).toBe(true);
    expect(saved[0]).toMatchObject({ mimeType: "application/pdf", size: pdfBytes.byteLength });
    expect(saved[1]?.path.endsWith("-2-empty.txt")).toBe(true);
    expect(saved[1]).toMatchObject({ mimeType: "text/plain", size: 0 });

    expect((await readFile(join(workspace, saved[0]?.path ?? ""))).equals(pdfBytes)).toBe(true);
    expect(await readFile(join(workspace, saved[1]?.path ?? ""))).toHaveLength(0);
  });

  it("does not overwrite an existing attachment name", async () => {
    const fixedNow = () => new Date("2026-06-13T12:05:01.123Z");
    const first = await saveAttachmentsToWorkspace(
      workspace,
      [{ kind: "file", mimeType: "text/plain", data: "QUJD", name: "note.txt" }],
      { now: fixedNow },
    );
    const second = await saveAttachmentsToWorkspace(
      workspace,
      [{ kind: "file", mimeType: "text/plain", data: "REVG", name: "note.txt" }],
      { now: fixedNow },
    );

    expect(second[0]?.path).not.toBe(first[0]?.path);
    expect(second[0]?.path.endsWith("-1-note-2.txt")).toBe(true);
    expect((await readFile(join(workspace, first[0]?.path ?? ""))).toString()).toBe("ABC");
    expect((await readFile(join(workspace, second[0]?.path ?? ""))).toString()).toBe("DEF");
  });

  it("rejects unsafe custom folders", async () => {
    await expect(saveAttachmentsToWorkspace(
      workspace,
      [{ kind: "image", mimeType: "image/png", data: pngBase64 }],
      { folder: "/tmp/uploads" },
    )).rejects.toThrow(/Absolute paths/);
    await expect(saveAttachmentsToWorkspace(
      workspace,
      [{ kind: "image", mimeType: "image/png", data: pngBase64 }],
      { folder: "../uploads" },
    )).rejects.toThrow(/Path traversal/);
  });

  it("honors a custom folder", async () => {
    const saved = await saveAttachmentsToWorkspace(
      workspace,
      [{ kind: "image", mimeType: "image/png", data: pngBase64 }],
      { folder: "uploads/images" },
    );
    expect(saved[0]?.path.startsWith("uploads/images/")).toBe(true);
  });

  it("rejects attachment folders that resolve outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pi-web-attachments-outside-"));
    externalDirectories.push(outside);
    await mkdir(join(workspace, ".pi-web"));
    await symlink(outside, join(workspace, ".pi-web", "attachments"), "dir");

    await expect(saveAttachmentsToWorkspace(
      workspace,
      [{ kind: "file", mimeType: "text/plain", data: "QUJD", name: "note.txt" }],
    )).rejects.toThrow(/Path escapes workspace/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("returns empty for no attachments", async () => {
    expect(await saveAttachmentsToWorkspace(workspace, [])).toEqual([]);
  });
});
