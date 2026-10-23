/** Independent refreshes apply their own results; the batch finishes only when all have settled. */
export async function completeRefreshBatch(refreshes: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(refreshes);
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, errors.map((error) => error instanceof Error ? error.message : String(error)).join("; "));
  }
}
