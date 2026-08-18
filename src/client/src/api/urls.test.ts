import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceFilePreviewPath, workspaceFilePreviewUrl } from "./urls";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("workspace file preview URLs", () => {
  it("builds an application-relative path with every dynamic value encoded once", () => {
    const path = workspaceFilePreviewPath(
      "project /?#%",
      "workspace /?#%",
      "reports/a b?#%/résumé.pdf",
      {
        machineId: "remote /?#%",
        modifiedAt: "2026-06-25T00:00:00.000Z +?",
        download: true,
      },
    );

    expect(path).toBe("api/machines/remote%20%2F%3F%23%25/projects/project%20%2F%3F%23%25/workspaces/workspace%20%2F%3F%23%25/file/preview?path=reports%2Fa+b%3F%23%25%2Fr%C3%A9sum%C3%A9.pdf&v=2026-06-25T00%3A00%3A00.000Z+%2B%3F&download=1");
  });

  it("resolves the preview path exactly once under a canonical nested deployment", () => {
    vi.stubEnv("BASE_URL", "./");
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/nested/pi-web/" });

    const url = workspaceFilePreviewUrl("project /?", "workspace /?", "docs/report #1.html", {
      machineId: "remote /?",
      download: true,
    });

    expect(url).toBe("https://pi.example.test/nested/pi-web/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%2F%3F/file/preview?path=docs%2Freport+%231.html&download=1");
  });
});
