import { describe, expect, it } from 'vitest';
import {
  formatEventId,
  parseLastEventId,
  serializeEvent,
  serializeHeartbeat,
} from '../../src/http/sse.js';

describe('sse serializer', () => {
  it('formatEventId composes <receivedAt>-<messageId>', () => {
    expect(formatEventId(1234567890, 'abc')).toBe('1234567890-abc');
  });

  it('serializeEvent emits id/event/data frame ending with double newline', () => {
    const out = serializeEvent({ id: '1-a', event: 'message', data: { x: 1 } });
    expect(out).toBe('id: 1-a\nevent: message\ndata: {"x":1}\n\n');
  });

  it('serializeEvent ends every frame with \\n\\n', () => {
    const out = serializeEvent({ id: '1-a', event: 'message', data: 'hello' });
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('serializeHeartbeat emits comment frame', () => {
    expect(serializeHeartbeat(100)).toBe(': heartbeat 100\n\n');
  });

  it('parseLastEventId handles prefix, plain number, missing, malformed', () => {
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId('')).toBe(0);
    expect(parseLastEventId('abc')).toBe(0);
    expect(parseLastEventId('100')).toBe(100);
    expect(parseLastEventId('1234-abc')).toBe(1234);
    expect(parseLastEventId(['5678-xyz'])).toBe(5678);
  });
});
