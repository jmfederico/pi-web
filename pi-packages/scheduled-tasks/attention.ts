import type { ExecutionStatus } from "./domain.js";

export const ATTENTION_STATUSES: readonly ExecutionStatus[] = ["failed", "errored", "uncertain"];
