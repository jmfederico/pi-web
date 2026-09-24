import { describe, expect, it } from "vitest";
import {
  defaultPackagedClientDist,
  devModeClientPointer,
  PI_WEB_BROWSER_URL_ENV,
  requirePackagedClientDist,
  resolveClientServing,
} from "./clientServing.js";

describe("resolveClientServing", () => {
  it("uses the declared browser entrypoint as explicit development mode", () => {
    expect(resolveClientServing({ env: { [PI_WEB_BROWSER_URL_ENV]: "http://127.0.0.1:8505" } }))
      .toEqual({ mode: "dev", browserEntrypointUrl: "http://127.0.0.1:8505" });
    expect(resolveClientServing({ env: { [PI_WEB_BROWSER_URL_ENV]: "https://dev.pi-web.test" } }))
      .toEqual({ mode: "dev", browserEntrypointUrl: "https://dev.pi-web.test" });
  });

  it("treats an unset or empty entrypoint as packaged mode rooted at the built client", () => {
    for (const env of [{}, { [PI_WEB_BROWSER_URL_ENV]: "" }]) {
      expect(resolveClientServing({ env, serverModuleDir: "/opt/pi-web/dist/server" }))
        .toEqual({ mode: "packaged", clientDist: "/opt/pi-web/dist/client" });
    }
  });

  it("rejects invalid entrypoint values instead of silently falling back", () => {
    expect(() => resolveClientServing({ env: { [PI_WEB_BROWSER_URL_ENV]: "not a url" } }))
      .toThrow(`${PI_WEB_BROWSER_URL_ENV} must be a valid URL`);
    expect(() => resolveClientServing({ env: { [PI_WEB_BROWSER_URL_ENV]: "ftp://127.0.0.1:8505" } }))
      .toThrow(`${PI_WEB_BROWSER_URL_ENV} must be an http:// or https:// URL`);
  });
});

describe("defaultPackagedClientDist", () => {
  it("anchors the built client at the package root from built and source server layouts", () => {
    expect(defaultPackagedClientDist("/home/user/.npm/pi-web/dist/server")).toBe("/home/user/.npm/pi-web/dist/client");
    expect(defaultPackagedClientDist("/home/user/projects/pi-web/src/server")).toBe("/home/user/projects/pi-web/dist/client");
  });
});

describe("requirePackagedClientDist", () => {
  it("accepts a build output containing the client entry page", () => {
    const seen: string[] = [];
    expect(() => { requirePackagedClientDist("/pkg/dist/client", (path) => {
      seen.push(path);
      return true;
    }); }).not.toThrow();
    expect(seen).toEqual(["/pkg/dist/client/index.html"]);
  });

  it("fails startup with an actionable error when the build output is missing", () => {
    expect(() => { requirePackagedClientDist("/pkg/dist/client", () => false); })
      .toThrow(/no built client found at \/pkg\/dist\/client.*npm run build.*npm run dev/su);
  });
});

describe("devModeClientPointer", () => {
  it("names the development browser entrypoint", () => {
    expect(devModeClientPointer("http://127.0.0.1:8505")).toContain("http://127.0.0.1:8505");
  });
});
