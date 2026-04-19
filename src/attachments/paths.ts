/**
 * Pure path logic for the hash-sharded attachment store.
 *
 * No fs, no I/O, no async — this module is deliberately side-effect-free so it
 * can be unit-tested trivially (plan 02-05) and reasoned about in isolation.
 *
 * The one job of this file: map a sha256 hex digest to its on-disk relative
 * path under the attachment store root. See D-25 / D-26 in 02-CONTEXT.md.
 */

/**
 * Converts a sha256 hex digest into its relative two-level sharded path.
 *
 * Format (D-25): `<first-2-hex>/<next-2-hex>/<sha256>`.
 *
 * Example:
 *   shardPath('de01ad02...rest64chars') === 'de/01/de01ad02...rest64chars'
 *
 * The path is POSIX-style with forward slashes regardless of the host OS.
 * Callers that need an OS-specific absolute path must prepend the root and
 * normalize via `node:path#join` (which writeAttachment / readAttachment do).
 *
 * @throws if `hex` is not a 64-char lowercase hex string (defense against
 *         accidental user-supplied input reaching this function).
 */
export function shardPath(hex: string): string {
  if (!isValidSha256Hex(hex)) {
    throw new Error(`shardPath: expected 64-char lowercase hex, got: ${redact(hex)}`);
  }
  return `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

/**
 * True iff `s` is exactly 64 lowercase hex characters — i.e., a valid sha256
 * hex digest. Used as a guard before using any value as a path component
 * (D-28: never a user-controlled path).
 *
 * Uppercase hex is rejected on purpose: `node:crypto`'s `digest('hex')` emits
 * lowercase, so anything else means the value was not produced by our hasher
 * and should be refused at the boundary.
 */
export function isValidSha256Hex(s: string): boolean {
  if (s.length !== 64) return false;
  // Manual loop is faster than regex for hot paths; attachment reads will call this.
  for (let i = 0; i < 64; i += 1) {
    const c = s.charCodeAt(i);
    // '0'-'9' = 48-57, 'a'-'f' = 97-102
    const isDigit = c >= 48 && c <= 57;
    const isLowerHex = c >= 97 && c <= 102;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

/**
 * Truncates + annotates a string for inclusion in an error message.
 *
 * Never leak full user input into logs: even a rejected sha candidate could
 * in theory contain attacker-controlled bytes (PII-minimization, PITFALLS #4).
 */
function redact(s: string): string {
  const shown = s.slice(0, 8);
  return `${shown}...(${s.length} chars)`;
}
