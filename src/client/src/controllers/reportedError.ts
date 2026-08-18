import type { GetState, SetState } from "./types";

/**
 * Owns one controller's use of the shared error banner.
 *
 * A controller may clear only the message it last reported itself. Background
 * refreshes therefore cannot erase a failure raised by a different action
 * before the user has read it, while a retry of the same operation still
 * removes its own stale message.
 */
export class ReportedError {
  private reported: string | undefined;

  constructor(private readonly getState: GetState, private readonly setState: SetState) {}

  /** Shows `message` in the shared banner and takes ownership of clearing it. */
  report(message: string): void {
    this.reported = message;
    this.setState({ error: message });
  }

  /** Removes this controller's own message; leaves any other message alone. */
  clear(): void {
    const reported = this.reported;
    this.reported = undefined;
    if (reported === undefined || this.getState().error !== reported) return;
    this.setState({ error: "" });
  }
}
