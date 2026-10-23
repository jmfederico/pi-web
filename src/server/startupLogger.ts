import type { FastifyServerOptions } from "fastify";

/** The readable startup banner replaces Fastify's per-address listening messages. */
export const startupLogger: Exclude<FastifyServerOptions["logger"], boolean | undefined> = {
  hooks: {
    logMethod(args, method, level) {
      if (level === 30 && args.length === 1 && typeof args[0] === "string" && args[0].startsWith("Server listening at ")) return;
      method.apply(this, args);
    },
  },
};
