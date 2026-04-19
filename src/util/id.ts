import { nanoid } from 'nanoid';

/**
 * Length of every ID produced by `newId()`.
 *
 * 22 chars * log2(64) alphabet = 132 bits of entropy.
 * Satisfies D-35 ("≥128-bit URL-safe ID") with margin.
 *
 * Used for all primary keys in the schema:
 * - inboxes.id, messages.id, attachments.id
 *
 * NOT used for:
 * - inbox local-part (that's a separate, shorter ID generated in Phase 3 core logic;
 *   see CORE-01, which requires >=64 bits via `nanoid(16, base32)`).
 * - view_token (Phase 3 generates + hashes; this module doesn't own that).
 */
export const ID_LENGTH = 22;

/**
 * Generates a new URL-safe 132-bit random identifier.
 *
 * Use for DB primary keys only. Never expose raw IDs in URL paths that third
 * parties might log (per PITFALLS.md section 9 enumeration — the address is separate).
 */
export function newId(): string {
  return nanoid(ID_LENGTH);
}
