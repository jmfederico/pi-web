import { NetworkRequestError } from "../api/http";

const RETRY_DELAYS_MS = [500, 1500, 3000];

/** Opt-in recovery for reads only; retired contexts discard both results and failures. */
export async function readWithNetworkRecovery<T>(read: () => Promise<T>, isCurrent: () => boolean): Promise<T | undefined> {
  if (!isCurrent()) return undefined;
  let retries = 0;
  for (;;) {
    let result: T;
    try {
      result = await read();
    } catch (error) {
      if (!isCurrent()) return undefined;
      const delay = RETRY_DELAYS_MS[retries];
      if (!(error instanceof NetworkRequestError) || delay === undefined) throw error;
      await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
      if (!isCurrent()) return undefined;
      retries += 1;
      continue;
    }
    return isCurrent() ? result : undefined;
  }
}
