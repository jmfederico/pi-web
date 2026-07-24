export function parseJsonString(value: string, errorMessage: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error(errorMessage);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === errorMessage) throw error;
    throw new Error(errorMessage, { cause: error });
  }
}
