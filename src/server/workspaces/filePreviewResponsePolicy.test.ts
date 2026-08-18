import { describe, expect, it } from "vitest";
import { workspaceFilePreviewErrorResponsePolicy, workspaceFilePreviewResponsePolicy } from "./filePreviewResponsePolicy.js";

const IMAGE_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'self'";
const HTML_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'self'";
const PDF_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'self'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'self'";
const DOWNLOAD_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'none'";
const ERROR_CSP = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'self'";

describe("workspaceFilePreviewResponsePolicy", () => {
  it("returns exact allowlisted image, HTML, and PDF response policy", () => {
    expect(workspaceFilePreviewResponsePolicy("diagram.svg")).toEqual({
      contentType: "image/svg+xml",
      contentDisposition: "inline; filename=\"diagram.svg\"; filename*=UTF-8''diagram.svg",
      contentSecurityPolicy: IMAGE_CSP,
      contentTypeOptions: "nosniff",
    });
    expect(workspaceFilePreviewResponsePolicy("report.html")).toEqual({
      contentType: "text/html; charset=utf-8",
      contentDisposition: "inline; filename=\"report.html\"; filename*=UTF-8''report.html",
      contentSecurityPolicy: HTML_CSP,
      contentTypeOptions: "nosniff",
    });
    expect(workspaceFilePreviewResponsePolicy("spec.pdf")).toEqual({
      contentType: "application/pdf",
      contentDisposition: "inline; filename=\"spec.pdf\"; filename*=UTF-8''spec.pdf",
      contentSecurityPolicy: PDF_CSP,
      contentTypeOptions: "nosniff",
    });
  });

  it("keeps the PDF sandbox relaxation minimal and unique to PDF", () => {
    // Native PDF handlers refuse to run in any sandboxed context, so the PDF
    // policy is the only one without a `sandbox` directive. It must still deny
    // script and every subresource except the plugin document the viewer embeds.
    const pdf = workspaceFilePreviewResponsePolicy("spec.pdf");
    expect(pdf.contentSecurityPolicy).not.toContain("sandbox");
    expect(pdf.contentSecurityPolicy).toContain("default-src 'none'");
    expect(pdf.contentSecurityPolicy).toContain("script-src 'none'");
    expect(pdf.contentSecurityPolicy).toContain("frame-ancestors 'self'");
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.contentTypeOptions).toBe("nosniff");

    const sandboxed = [
      workspaceFilePreviewResponsePolicy("diagram.svg"),
      workspaceFilePreviewResponsePolicy("report.html"),
      workspaceFilePreviewResponsePolicy("archive.zip", { download: true }),
      workspaceFilePreviewErrorResponsePolicy(),
    ];
    for (const policy of sandboxed) expect(policy.contentSecurityPolicy.startsWith("sandbox;")).toBe(true);
  });

  it("forces every download to an octet-stream attachment with restrictive policy", () => {
    expect(workspaceFilePreviewResponsePolicy("archive.zip", { download: true })).toEqual({
      contentType: "application/octet-stream",
      contentDisposition: "attachment; filename=\"archive.zip\"; filename*=UTF-8''archive.zip",
      contentSecurityPolicy: DOWNLOAD_CSP,
      contentTypeOptions: "nosniff",
    });
  });

  it("uses a safe quoted fallback and RFC 5987 encoding for hostile and non-ASCII filenames", () => {
    const policy = workspaceFilePreviewResponsePolicy("reports/résumé's \"draft\".pdf");
    expect(policy.contentDisposition).toBe("inline; filename=\"r_sum_'s _draft_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%27s%20%22draft%22.pdf");

    const hostile = workspaceFilePreviewResponsePolicy("bad\"\r\nX-Evil: yes.html");
    expect(hostile.contentDisposition).not.toMatch(/[\r\n]/u);
    expect(hostile.contentDisposition).toContain("filename*=UTF-8''bad%22%0D%0AX-Evil%3A%20yes.html");

    const windowsDownload = workspaceFilePreviewResponsePolicy(String.raw`C:\reports\résumé.pdf`, { download: true });
    expect(windowsDownload.contentDisposition).toBe("attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it("neutralizes proxied preview errors without hiding their JSON body", () => {
    expect(workspaceFilePreviewErrorResponsePolicy()).toEqual({
      contentType: "application/json; charset=utf-8",
      contentDisposition: "inline",
      contentSecurityPolicy: ERROR_CSP,
      contentTypeOptions: "nosniff",
    });
  });

  it("does not expose Markdown or unsupported files as raw streamed previews", () => {
    expect(() => workspaceFilePreviewResponsePolicy("README.md")).toThrow("Inline preview is not supported");
    expect(() => workspaceFilePreviewResponsePolicy("archive.zip")).toThrow("Inline preview is not supported");
  });
});
