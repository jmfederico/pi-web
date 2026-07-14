import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandSecureInputService, registerSecureInputRoutes, type SecureInputService } from "./secureInputRoutes.js";

const contentType = "application/vnd.pi-web.secure-input";
const requiredHeaders = { "content-type": contentType, "x-pi-web-secure-input": "1" };

let app: FastifyInstance;
let submit: ReturnType<typeof vi.fn<SecureInputService["submit"]>>;

beforeEach(async () => {
  submit = vi.fn<SecureInputService["submit"]>(() => Promise.resolve({ accepted: true, receiptId: "receipt-1", acceptedAt: "2026-07-14T00:00:00.000Z" }));
  app = Fastify({ logger: false });
  registerSecureInputRoutes(app, { status: () => ({ enabled: true, label: "Secret", maxBytes: 4096 }), submit });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("secure input routes", () => {
  it("exposes only public receiver metadata", async () => {
    const response = await app.inject({ method: "GET", url: "/api/secure-input" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ enabled: true, label: "Secret", maxBytes: 4096 });
    expect(response.body).not.toContain("command");
  });

  it("requires the non-simple same-origin request header before invoking the receiver", async () => {
    const response = await app.inject({ method: "POST", url: "/api/secure-input", headers: { "content-type": contentType }, payload: "do-not-forward" });

    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("do-not-forward");
    expect(submit).not.toHaveBeenCalled();
  });

  it("passes exact UTF-8 bytes without echoing them and clears the request buffer", async () => {
    const secret = "thư bí mật 🔒";
    let received: Buffer | undefined;
    submit.mockImplementation((input) => {
      received = input;
      expect(Buffer.from(input)).toEqual(Buffer.from(secret, "utf8"));
      return Promise.resolve({ accepted: true, receiptId: "receipt-1", acceptedAt: "2026-07-14T00:00:00.000Z" });
    });

    const response = await app.inject({ method: "POST", url: "/api/secure-input", headers: requiredHeaders, payload: Buffer.from(secret, "utf8") });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ accepted: true, receiptId: "receipt-1", acceptedAt: "2026-07-14T00:00:00.000Z" });
    expect(response.body).not.toContain(secret);
    expect(received).toBeDefined();
    expect(received?.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects oversized input before invoking the receiver", async () => {
    const response = await app.inject({ method: "POST", url: "/api/secure-input", headers: requiredHeaders, payload: Buffer.alloc(4097, 97) });

    expect(response.statusCode).toBe(413);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not return receiver diagnostics or submitted input on failure", async () => {
    submit.mockRejectedValue(new Error("receiver leaked do-not-return"));

    const response = await app.inject({ method: "POST", url: "/api/secure-input", headers: requiredHeaders, payload: "do-not-return" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Secure input receiver failed" });
    expect(response.body).not.toContain("do-not-return");
    expect(response.body).not.toContain("receiver leaked");
  });
});

describe("command secure input service", () => {
  it("writes exact bytes to a fixed argv receiver through stdin", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-secure-input-"));
    const output = join(tempDir, "received.bin");
    const script = "const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],Buffer.concat(chunks)));";
    const service = new CommandSecureInputService(() => ({
      command: [process.execPath, "-e", script, output],
      label: "Secret",
      maxBytes: 4096,
      timeoutMs: 5_000,
    }));
    const input = Buffer.from("exact\u0000UTF-8: thư 🔒", "utf8");

    try {
      const receipt = await service.submit(input);
      expect(receipt).toMatchObject({ accepted: true });
      expect(await readFile(output)).toEqual(input);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects concurrent submissions while the receiver is active", async () => {
    const service = new CommandSecureInputService(() => ({
      command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 100)"],
      label: "Secret",
      maxBytes: 4096,
      timeoutMs: 5_000,
    }));

    const first = service.submit(Buffer.from("first"));
    await expect(service.submit(Buffer.from("second"))).rejects.toThrow("Another secure input submission is in progress");
    await expect(first).resolves.toMatchObject({ accepted: true });
  });

  it("terminates a receiver that exceeds its configured timeout", async () => {
    const service = new CommandSecureInputService(() => ({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      label: "Secret",
      maxBytes: 4096,
      timeoutMs: 25,
    }));

    await expect(service.submit(Buffer.from("timeout"))).rejects.toThrow("Secure input receiver timed out");
  });

  it("fails closed when not configured", async () => {
    const service = new CommandSecureInputService(() => undefined);

    expect(service.status()).toEqual({ enabled: false });
    await expect(service.submit(Buffer.from("x"))).rejects.toThrow("Secure input is not configured");
  });
});
