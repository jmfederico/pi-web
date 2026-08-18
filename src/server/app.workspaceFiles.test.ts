import { mkdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_INLINE_PREVIEW_BYTES } from "../shared/workspaceFiles.js";
import type { Project, WorkspaceProviderResolution } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import { workspaceFilePreviewErrorResponsePolicy, workspaceFilePreviewResponsePolicy } from "./workspaces/filePreviewResponsePolicy.js";

registerAppTestHooks();

describe("buildApp workspace file routes", () => {
  it("serves workspace SVG only with exact inline-image containment headers", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Images", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>window.top.location = "https://attacker.test"</script>
      <image href="https://attacker.test/tracker.png" />
      <foreignObject><button onclick="alert(2)">active</button></foreignObject>
    </svg>`;
    await writeFile(join(appTestContext.projectDir, "diagram.svg"), svg);
    await writeFile(join(appTestContext.projectDir, "note.txt"), "hello");
    await writeFile(join(appTestContext.projectDir, "huge.png"), "");
    await truncate(join(appTestContext.projectDir, "huge.png"), MAX_INLINE_PREVIEW_BYTES + 1);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const previewPath = `/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("diagram.svg")}`;
    const previewResponse = await appTestContext.app.inject({ method: "GET", url: `/api${previewPath}` });
    const localAliasResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local${previewPath}` });
    const policy = workspaceFilePreviewResponsePolicy("diagram.svg");

    for (const response of [previewResponse, localAliasResponse]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(policy.contentType);
      expect(response.headers["cache-control"]).toBe("private, max-age=3600");
      expect(response.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
      expect(response.headers["content-disposition"]).toBe(policy.contentDisposition);
      expect(response.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
      expect(response.body).toBe(svg);
    }

    const rejectedResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("note.txt")}` });
    expect(rejectedResponse.statusCode).toBe(400);
    expect(rejectedResponse.json()).toEqual({ error: "Inline preview is not supported for this file type" });

    const tooLargeResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("huge.png")}` });
    expect(tooLargeResponse.statusCode).toBe(400);
    expect(tooLargeResponse.json()).toEqual({ error: "File is too large to preview (limit 10 MB)" });
  });

  it("hardens failed local previews with the same error policy the remote proxy enforces", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Errors", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    await writeFile(join(appTestContext.projectDir, "note.txt"), "hello");
    await writeFile(join(appTestContext.projectDir, "huge.png"), "");
    await truncate(join(appTestContext.projectDir, "huge.png"), MAX_INLINE_PREVIEW_BYTES + 1);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const previewPath = (path: string): string => `/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent(path)}`;
    const failures: { path: string; error: string }[] = [
      { path: "note.txt", error: "Inline preview is not supported for this file type" },
      { path: "huge.png", error: "File is too large to preview (limit 10 MB)" },
      { path: "../escape<script>.png", error: "Path traversal is not allowed" },
    ];
    const policy = workspaceFilePreviewErrorResponsePolicy();

    for (const failure of failures) {
      const responses = await Promise.all([
        appTestContext.app.inject({ method: "GET", url: `/api${previewPath(failure.path)}` }),
        appTestContext.app.inject({ method: "GET", url: `/api/machines/local${previewPath(failure.path)}` }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: failure.error });
        expect(response.headers["content-type"]).toBe(policy.contentType);
        expect(response.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
        expect(response.headers["content-disposition"]).toBe(policy.contentDisposition);
        expect(response.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
      }
    }
  });

  it("serves HTML and PDF inline with type-appropriate sandbox policies", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Docs", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const htmlBody = "<h1>Report</h1><script>alert(1)</script>";
    await writeFile(join(appTestContext.projectDir, "report.html"), htmlBody);
    await writeFile(join(appTestContext.projectDir, "spec.pdf"), "%PDF-1.4\n%mock\n");

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const htmlPath = `/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("report.html")}`;
    const htmlResponses = await Promise.all([
      appTestContext.app.inject({ method: "GET", url: `/api${htmlPath}` }),
      appTestContext.app.inject({ method: "GET", url: `/api/machines/local${htmlPath}` }),
    ]);
    const htmlPolicy = workspaceFilePreviewResponsePolicy("report.html");
    for (const htmlResponse of htmlResponses) {
      expect(htmlResponse.statusCode).toBe(200);
      expect(htmlResponse.headers["content-type"]).toBe(htmlPolicy.contentType);
      expect(htmlResponse.headers["content-disposition"]).toBe(htmlPolicy.contentDisposition);
      expect(htmlResponse.headers["content-security-policy"]).toBe(htmlPolicy.contentSecurityPolicy);
      expect(htmlResponse.headers["x-content-type-options"]).toBe(htmlPolicy.contentTypeOptions);
      expect(htmlResponse.body).toBe(htmlBody);
    }

    const pdfPath = `/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent("spec.pdf")}`;
    const pdfResponses = await Promise.all([
      appTestContext.app.inject({ method: "GET", url: `/api${pdfPath}` }),
      appTestContext.app.inject({ method: "GET", url: `/api/machines/local${pdfPath}` }),
    ]);
    const pdfPolicy = workspaceFilePreviewResponsePolicy("spec.pdf");
    for (const pdfResponse of pdfResponses) {
      expect(pdfResponse.statusCode).toBe(200);
      expect(pdfResponse.headers["content-type"]).toBe(pdfPolicy.contentType);
      expect(pdfResponse.headers["content-disposition"]).toBe(pdfPolicy.contentDisposition);
      expect(pdfResponse.headers["content-security-policy"]).toBe(pdfPolicy.contentSecurityPolicy);
      expect(pdfResponse.headers["x-content-type-options"]).toBe(pdfPolicy.contentTypeOptions);
      expect(pdfResponse.body).toBe("%PDF-1.4\n%mock\n");
    }
  });

  it("serves any file as an attachment download regardless of type", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Downloads", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    // Non-ASCII, an apostrophe, and a space all survive a real round trip on
    // every supported host. Windows forbids `"` in filenames, so quote and CRLF
    // escaping is proven at the pure policy seam instead
    // (`filePreviewResponsePolicy.test.ts`) rather than through a real file.
    const filename = "résumé's notes.txt";
    await writeFile(join(appTestContext.projectDir, filename), "just text");

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const downloadPath = `/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent(filename)}&download=1`;
    const downloadResponses = await Promise.all([
      appTestContext.app.inject({ method: "GET", url: `/api${downloadPath}` }),
      appTestContext.app.inject({ method: "GET", url: `/api/machines/local${downloadPath}` }),
    ]);
    const policy = workspaceFilePreviewResponsePolicy(filename, { download: true });
    for (const downloadResponse of downloadResponses) {
      expect(downloadResponse.statusCode).toBe(200);
      expect(downloadResponse.headers["content-type"]).toBe(policy.contentType);
      expect(downloadResponse.headers["content-disposition"]).toBe(policy.contentDisposition);
      expect(downloadResponse.headers["content-security-policy"]).toBe(policy.contentSecurityPolicy);
      expect(downloadResponse.headers["x-content-type-options"]).toBe(policy.contentTypeOptions);
      expect(downloadResponse.body).toBe("just text");
    }
  });

  it("advertises a content length that matches the bytes it serves", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Framing", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    await writeFile(join(appTestContext.projectDir, "report.html"), "<h1>Report</h1>");
    await writeFile(join(appTestContext.projectDir, "empty.html"), "");
    await writeFile(join(appTestContext.projectDir, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const requests = [
      { path: "report.html", query: "", bytes: 15 },
      { path: "empty.html", query: "", bytes: 0 },
      { path: "archive.zip", query: "&download=1", bytes: 5 },
    ];
    for (const request of requests) {
      const response = await appTestContext.app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/preview?path=${encodeURIComponent(request.path)}${request.query}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.byteLength).toBe(request.bytes);
      expect(response.headers["content-length"]).toBe(String(request.bytes));
    }
  });

  it("keeps normal file suggestions workspace-local when path access config is invalid", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Local Suggestions", path: appTestContext.projectDir, create: true },
    });
    expect(addResponse.statusCode).toBe(200);
    const project = addResponse.json<Project>();
    await writeFile(join(appTestContext.projectDir, "sdk.md"), "local sdk\n");

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await mkdir(join(appTestContext.projectDir, ".pi-web"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, pathAccess: { allowedPaths: [""] } }, null, 2)}\n`);

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/files?q=sdk&scope=all` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ path: "sdk.md", kind: "other" }]);
  });

  it("uses the owning project config for suggestions from an authoritative linked workspace", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Linked", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const mainWorkspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (mainWorkspace === undefined) throw new Error("Expected workspace");
    const linkedDir = join(appTestContext.tempDir, "linked-workspace");
    const externalDir = join(appTestContext.tempDir, "linked-external-docs");
    await mkdir(linkedDir);
    await mkdir(externalDir);
    await writeFile(join(externalDir, "sdk.md"), "external sdk\n");
    await mkdir(join(appTestContext.projectDir, ".pi-web"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, pathAccess: { allowedPaths: [externalDir] } }, null, 2)}\n`);
    appTestContext.workspaceCatalog.set(project.id, [{
      ...mainWorkspace,
      id: "linked",
      path: linkedDir,
      label: "linked",
    }]);

    const response = await appTestContext.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspaces/linked/files?q=${encodeURIComponent(join(externalDir, "s"))}&scope=all`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ path: join(externalDir, "sdk.md"), kind: "other" }]);
  });

  it("serves project-configured allowed external files through the workspace explorer", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "External", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const externalDir = join(appTestContext.tempDir, "external-docs");
    const deniedFile = join(appTestContext.tempDir, "secret.md");
    await mkdir(externalDir);
    await writeFile(join(externalDir, "sdk.md"), "external sdk\n");
    await writeFile(deniedFile, "secret\n");
    await mkdir(join(appTestContext.projectDir, ".pi-web"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, pathAccess: { allowedPaths: [externalDir] } }, null, 2)}\n`);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const fileResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(join(externalDir, "sdk.md"))}` });
    const treeResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/tree?path=${encodeURIComponent(externalDir)}` });
    const suggestionResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/files?q=${encodeURIComponent(join(externalDir, "s"))}` });
    const localSuggestionResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/files?q=sdk` });
    const deniedResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent(deniedFile)}` });

    expect(fileResponse.statusCode).toBe(200);
    expect(fileResponse.json()).toMatchObject({ path: join(externalDir, "sdk.md"), content: "external sdk\n", binary: false });
    expect(treeResponse.statusCode).toBe(200);
    expect(treeResponse.json()).toMatchObject({
      path: externalDir,
      entries: [expect.objectContaining({ name: "sdk.md", path: join(externalDir, "sdk.md"), type: "file" })],
      truncated: false,
    });
    expect(suggestionResponse.statusCode).toBe(200);
    expect(suggestionResponse.json()).toEqual([{ path: join(externalDir, "sdk.md"), kind: "other" }]);
    expect(localSuggestionResponse.statusCode).toBe(200);
    expect(localSuggestionResponse.json()).toEqual([]);
    expect(deniedResponse.statusCode).toBe(400);
    expect(deniedResponse.json()).toEqual({ error: "Path is outside allowed paths" });
  });

  it("writes workspace files through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "WriteTest", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const writeTextResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}`,
      payload: "hello world",
      headers: { "content-type": "text/plain" },
    });
    expect(writeTextResponse.statusCode).toBe(200);
    expect(writeTextResponse.json()).toMatchObject({ path: "hello.txt", created: true });
    expect(typeof writeTextResponse.json<{ size: unknown }>().size).toBe("number");

    const readResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}` });
    expect(readResponse.json<{ content: unknown }>().content).toBe("hello world");

    const writeBinaryResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("image.png")}`,
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(writeBinaryResponse.statusCode).toBe(200);
    expect(writeBinaryResponse.json()).toMatchObject({ path: "image.png", created: true });

    const writeDeepResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("deep/nested/dir/file.txt")}`,
      payload: "deep content",
      headers: { "content-type": "text/plain" },
    });
    expect(writeDeepResponse.statusCode).toBe(200);

    const readDeepResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("deep/nested/dir/file.txt")}` });
    expect(readDeepResponse.json<{ content: unknown }>().content).toBe("deep content");

    const overwriteResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}`,
      payload: "updated",
      headers: { "content-type": "text/plain" },
    });
    expect(overwriteResponse.json()).toMatchObject({ path: "hello.txt", created: false });

    const noOverwriteResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("hello.txt")}&overwrite=false`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(noOverwriteResponse.statusCode).toBe(400);
    expect(noOverwriteResponse.json<{ error: string }>().error).toContain("File already exists");

    const traversalResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
      payload: "evil",
      headers: { "content-type": "text/plain" },
    });
    expect(traversalResponse.statusCode).toBe(400);
    expect(traversalResponse.json<{ error: string }>().error).toContain("Path traversal");

    const noPathResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file`,
      payload: "no path",
      headers: { "content-type": "text/plain" },
    });
    expect(noPathResponse.statusCode).toBe(400);
    expect(noPathResponse.json<{ error: string }>().error).toContain("path query parameter is required");

    const noDirsResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("nonexistent/parent/file.txt")}&createDirs=false`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(noDirsResponse.statusCode).toBe(400);

    await mkdir(join(appTestContext.projectDir, "subdir"), { recursive: true });
    const dirWriteResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("subdir")}`,
      payload: "should fail",
      headers: { "content-type": "text/plain" },
    });
    expect(dirWriteResponse.statusCode).toBe(400);
  });

  it("deletes workspace files through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "DeleteTest", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("to-delete.txt")}`,
      payload: "delete me",
      headers: { "content-type": "text/plain" },
    });

    const deleteResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("to-delete.txt")}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ path: "to-delete.txt", existed: true });

    const deleteMissingResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("missing.txt")}`,
    });
    expect(deleteMissingResponse.statusCode).toBe(200);
    expect(deleteMissingResponse.json()).toMatchObject({ path: "missing.txt", existed: false });

    const traversalResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("../../etc/passwd")}`,
    });
    expect(traversalResponse.statusCode).toBe(400);
    expect(traversalResponse.json<{ error: string }>().error).toContain("Path traversal");

    const noPathResponse = await appTestContext.app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file`,
    });
    expect(noPathResponse.statusCode).toBe(400);
    expect(noPathResponse.json<{ error: string }>().error).toContain("path query parameter is required");
  });

  it("moves workspace files through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "MoveTest", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("original.txt")}`,
      payload: "move me",
      headers: { "content-type": "text/plain" },
    });

    const moveResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("original.txt")}&toPath=${encodeURIComponent("moved.txt")}`,
    });
    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json()).toMatchObject({ fromPath: "original.txt", toPath: "moved.txt" });
    expect(typeof moveResponse.json<{ size: unknown }>().size).toBe("number");

    const readSourceResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("original.txt")}` });
    expect(readSourceResponse.statusCode).toBe(400);

    const readTargetResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("moved.txt")}` });
    expect(readTargetResponse.statusCode).toBe(200);
    expect(readTargetResponse.json<{ content: unknown }>().content).toBe("move me");

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("source2.txt")}`,
      payload: "source",
      headers: { "content-type": "text/plain" },
    });
    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("target2.txt")}`,
      payload: "target",
      headers: { "content-type": "text/plain" },
    });

    const overwriteResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("source2.txt")}&toPath=${encodeURIComponent("target2.txt")}&overwrite=true`,
    });
    expect(overwriteResponse.statusCode).toBe(200);

    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("source3.txt")}`,
      payload: "s",
      headers: { "content-type": "text/plain" },
    });
    await appTestContext.app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file?path=${encodeURIComponent("target3.txt")}`,
      payload: "t",
      headers: { "content-type": "text/plain" },
    });
    const noOverwriteResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("source3.txt")}&toPath=${encodeURIComponent("target3.txt")}`,
    });
    expect(noOverwriteResponse.statusCode).toBe(400);
    expect(noOverwriteResponse.json<{ error: string }>().error).toContain("File already exists");

    const traversalFromResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move?fromPath=${encodeURIComponent("../../etc/passwd")}&toPath=${encodeURIComponent("safe.txt")}`,
    });
    expect(traversalFromResponse.statusCode).toBe(400);

    const noParamsResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${workspace.id}/file/move`,
    });
    expect(noParamsResponse.statusCode).toBe(400);
    expect(noParamsResponse.json<{ error: string }>().error).toContain("fromPath query parameter is required");
  });

  it("rejects stale workspace ids absent from the authoritative catalog", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Authority", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const staleWorkspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (staleWorkspace === undefined) throw new Error("Expected workspace");
    const replacementPath = join(appTestContext.tempDir, "replacement");
    await mkdir(replacementPath);
    appTestContext.workspaceCatalog.set(project.id, [{
      ...staleWorkspace,
      id: "replacement",
      path: replacementPath,
      label: "replacement",
    }]);

    const fileResponse = await appTestContext.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspaces/${staleWorkspace.id}/file?path=${encodeURIComponent("missing.txt")}`,
    });

    expect(fileResponse.statusCode).toBe(400);
    expect(fileResponse.json()).toEqual({ error: "Workspace not found" });
  });
});
