/**
 * SSE frame serializer (D-14, D-15).
 *
 * Produces strings that match the text/event-stream spec:
 *
 *   id: <id>\n
 *   event: <event>\n
 *   data: <line1>\n
 *   data: <line2>\n
 *   \n
 *
 * - Multi-line data is split at \n; each line is prefixed with `data: `.
 * - Event id format: `<receivedAtMs>-<messageId>` (D-15). Last-Event-ID on
 *   reconnect is parsed as the numeric prefix before the first hyphen.
 * - Heartbeat frames are a single comment line + blank line.
 */

export interface SseEventFrame {
  id: string;
  event: string;
  data: unknown; // JSON-serialized
}

export function formatEventId(receivedAtMs: number, messageId: string): string {
  return `${receivedAtMs}-${messageId}`;
}

/** Parses `Last-Event-ID` back to a numeric receivedAtMs. Returns 0 on malformed. */
export function parseLastEventId(raw: string | string[] | undefined): number {
  if (!raw) return 0;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return 0;
  const dash = value.indexOf('-');
  const prefix = dash < 0 ? value : value.slice(0, dash);
  const n = Number.parseInt(prefix, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function serializeEvent(frame: SseEventFrame): string {
  const json = JSON.stringify(frame.data);
  const dataLines = json
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `id: ${frame.id}\nevent: ${frame.event}\n${dataLines}\n\n`;
}

export function serializeHeartbeat(nowMs: number): string {
  return `: heartbeat ${nowMs}\n\n`;
}
