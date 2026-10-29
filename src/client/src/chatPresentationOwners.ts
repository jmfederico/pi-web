/**
 * Tab-owned aliases join provisional and committed presentation addresses.
 * Values contain identifiers only, never transcript bodies or component instances.
 */
export class ChatPresentationOwners {
  private readonly owners = new Map<string, string>();

  constructor(private readonly limit = 2048) {
    if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError("Presentation alias limit must be at least two");
  }

  resolve(scope: string, identity: string, provisionalIdentity?: string): { owner: string; canonical: string } {
    const canonical = JSON.stringify([scope, identity]);
    const provisional = provisionalIdentity === undefined ? undefined : JSON.stringify([scope, provisionalIdentity]);
    const owner = this.owners.get(canonical)
      ?? (provisional === undefined ? undefined : this.owners.get(provisional))
      ?? canonical;
    this.remember(canonical, owner);
    if (provisional !== undefined && provisional !== canonical) this.remember(provisional, owner);
    return { owner, canonical };
  }

  private remember(address: string, owner: string): void {
    this.owners.delete(address);
    this.owners.set(address, owner);
    while (this.owners.size > this.limit) {
      const oldest = this.owners.keys().next().value;
      if (oldest !== undefined) this.owners.delete(oldest);
    }
  }
}
