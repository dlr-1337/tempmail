/**
 * Returns the current wall-clock time in epoch milliseconds (UTC).
 *
 * Why this exists:
 * - All timestamps in the schema are INTEGER epoch ms (D-10).
 * - Centralizing now() lets tests freeze time via `vi.spyOn(nowModule, 'nowMs')`.
 * - Matches the type expected by `inboxes.created_at`, etc., without casts.
 */
export function nowMs(): number {
  return Date.now();
}
