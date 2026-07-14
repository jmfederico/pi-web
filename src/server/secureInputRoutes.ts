import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyReply } from "fastify";
import { DEFAULT_SECURE_INPUT_MAX_BYTES, loadSecureInputConfig, type SecureInputConfig } from "../config.js";
import type { SecureInputReceipt, SecureInputStatusResponse } from "../shared/apiTypes.js";

const SECURE_INPUT_CONTENT_TYPE = "application/vnd.pi-web.secure-input";
const SECURE_INPUT_HEADER = "x-pi-web-secure-input";

export interface SecureInputService {
  status: () => SecureInputStatusResponse | Promise<SecureInputStatusResponse>;
  submit: (input: Buffer) => SecureInputReceipt | Promise<SecureInputReceipt>;
}

export class CommandSecureInputService implements SecureInputService {
  private active = false;

  constructor(private readonly readConfig: () => SecureInputConfig | undefined = () => loadSecureInputConfig()) {}

  status(): SecureInputStatusResponse {
    const config = this.readConfig();
    if (config === undefined) return { enabled: false };
    return { enabled: true, label: config.label, maxBytes: config.maxBytes };
  }

  async submit(input: Buffer): Promise<SecureInputReceipt> {
    const config = this.readConfig();
    if (config === undefined) throw new SecureInputError(404, "Secure input is not configured");
    if (input.length === 0) throw new SecureInputError(400, "Secure input cannot be empty");
    if (input.length > config.maxBytes) throw new SecureInputError(413, `Secure input exceeds the ${String(config.maxBytes)} byte limit`);
    if (this.active) throw new SecureInputError(409, "Another secure input submission is in progress");

    this.active = true;
    try {
      await runReceiver(config, input);
      return { accepted: true, receiptId: randomUUID(), acceptedAt: new Date().toISOString() };
    } finally {
      this.active = false;
    }
  }
}

export function registerSecureInputRoutes(app: FastifyInstance, service: SecureInputService = new CommandSecureInputService()): void {
  try {
    app.addContentTypeParser(SECURE_INPUT_CONTENT_TYPE, { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });
  } catch {
    // Route registration may be composed more than once in tests.
  }

  app.get("/api/secure-input", async (_request, reply) => {
    return noStore(reply).send(await service.status());
  });

  app.post<{ Body: Buffer }>("/api/secure-input", {
    bodyLimit: DEFAULT_SECURE_INPUT_MAX_BYTES,
    onRequest: (_request, reply, done) => { noStore(reply); done(); },
  }, async (request, reply) => {
    const body = request.body;
    try {
      if (request.headers[SECURE_INPUT_HEADER] !== "1") {
        return await noStore(reply).code(403).send({ error: "Secure input request header is required" });
      }
      if (!Buffer.isBuffer(body)) {
        return await noStore(reply).code(415).send({ error: `Secure input requires ${SECURE_INPUT_CONTENT_TYPE}` });
      }
      return await noStore(reply).send(await service.submit(body));
    } catch (error) {
      const statusCode = error instanceof SecureInputError ? error.statusCode : 502;
      const message = error instanceof SecureInputError ? error.message : "Secure input receiver failed";
      return await noStore(reply).code(statusCode).send({ error: message });
    } finally {
      if (Buffer.isBuffer(body)) body.fill(0);
    }
  });
}

class SecureInputError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
}

function runReceiver(config: SecureInputConfig, input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = config.command;
    const child = spawn(file, args, {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    let pendingError: SecureInputError | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (error === undefined) resolve();
      else reject(error);
    };
    const terminate = (error: SecureInputError) => {
      if (settled || pendingError !== undefined) return;
      pendingError = error;
      child.kill();
      forceKill = setTimeout(() => { child.kill("SIGKILL"); }, 1_000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => {
      terminate(new SecureInputError(504, "Secure input receiver timed out"));
    }, config.timeoutMs);
    timeout.unref();

    child.once("error", () => { finish(new SecureInputError(502, "Secure input receiver could not start")); });
    child.once("close", (code) => {
      finish(pendingError ?? (code === 0 ? undefined : new SecureInputError(502, "Secure input receiver rejected the submission")));
    });
    child.stdin.once("error", () => {
      terminate(new SecureInputError(502, "Secure input receiver closed before accepting the submission"));
    });
    child.stdin.end(input);
  });
}
