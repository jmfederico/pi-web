// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { browserGatewayDisplayUrl, gatewayDisplayUrl, machineIconUrl } from "./instanceIdentity";

describe("machineIconUrl", () => {
  it("uses the app's own favicon for the local machine", () => {
    expect(machineIconUrl({ kind: "local" })).toBe(`${document.baseURI}favicon.svg`);
  });

  it("points at the remote machine's own favicon", () => {
    expect(machineIconUrl({ kind: "remote", baseUrl: "https://fleet-a.example.com/" })).toBe("https://fleet-a.example.com/favicon.svg");
  });

  it("keeps nested deployment paths and defends a missing trailing slash", () => {
    expect(machineIconUrl({ kind: "remote", baseUrl: "https://fleet-a.example.com/pi-web/" })).toBe("https://fleet-a.example.com/pi-web/favicon.svg");
    expect(machineIconUrl({ kind: "remote", baseUrl: "https://fleet-a.example.com/pi-web" })).toBe("https://fleet-a.example.com/pi-web/favicon.svg");
  });

  it("falls back to the app favicon when a remote has no base URL", () => {
    expect(machineIconUrl({ kind: "remote" })).toBe(`${document.baseURI}favicon.svg`);
  });
});

describe("gatewayDisplayUrl", () => {
  it("keeps the host, including a non-default port", () => {
    expect(gatewayDisplayUrl("https://pi-dev.example.com:8505/")).toBe("pi-dev.example.com:8505");
  });

  it("keeps a nested deployment path without its trailing slash", () => {
    expect(gatewayDisplayUrl("https://example.com/pi-web/")).toBe("example.com/pi-web");
  });

  it("omits the root path", () => {
    expect(gatewayDisplayUrl("https://example.com/")).toBe("example.com");
  });
});

describe("browserGatewayDisplayUrl", () => {
  it("reflects the document host", () => {
    expect(browserGatewayDisplayUrl()).toBe(document.location.host);
  });
});
