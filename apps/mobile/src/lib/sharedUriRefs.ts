/**
 * Reference counts for content:// URIs received from Android's share sheet.
 *
 * Sending one shared file to several PCs creates one upload per PC, all reading
 * the same URI. The URI (and the temporary copy behind it) may only be released
 * when the LAST of those uploads is done or cancelled, not the first.
 */
export class SharedUriRefs {
  private readonly counts = new Map<string, number>();

  /** Declares that `count` uploads will each call release() once. */
  retain(uri: string, count = 1): void {
    if (!uri || count <= 0) return;
    this.counts.set(uri, (this.counts.get(uri) ?? 0) + count);
  }

  /** Returns true when nobody else still uses the URI and it should really be released. */
  release(uri: string): boolean {
    const n = this.counts.get(uri) ?? 0;
    if (n > 1) {
      this.counts.set(uri, n - 1);
      return false;
    }
    this.counts.delete(uri);
    return true; // the last user, or a URI that was never counted (single upload)
  }

  /** How many users are still registered (for tests and diagnostics). */
  holders(uri: string): number {
    return this.counts.get(uri) ?? 0;
  }
}

export const sharedUriRefs = new SharedUriRefs();
