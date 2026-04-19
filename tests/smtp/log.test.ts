/**
 * PII-safe log helper coverage (Phase 4 CONTEXT D-26..D-29).
 */

import { describe, expect, it, vi } from 'vitest';
import { type SmtpPinoLike, createSmtpLogger, hashLocalPart } from '../../src/smtp/log.js';

const captureLogger = (): {
  entries: Array<{ level: string; obj: Record<string, unknown>; msg?: string }>;
  pino: SmtpPinoLike;
} => {
  const entries: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
  const pino: SmtpPinoLike = {
    info: (obj, msg) => entries.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj: obj as Record<string, unknown>, msg }),
    error: (obj, msg) => entries.push({ level: 'error', obj: obj as Record<string, unknown>, msg }),
  };
  return { entries, pino };
};

describe('hashLocalPart', () => {
  it('returns 16 hex chars', () => {
    const h = hashLocalPart('alice', 'example.test', 'pepper-0');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input triple', () => {
    const a = hashLocalPart('alice', 'example.test', 'pepper-0');
    const b = hashLocalPart('alice', 'example.test', 'pepper-0');
    expect(a).toBe(b);
  });

  it('differs when salt rotates', () => {
    const a = hashLocalPart('alice', 'example.test', 'pepper-0');
    const b = hashLocalPart('alice', 'example.test', 'pepper-1');
    expect(a).not.toBe(b);
  });

  it('differs when local-part differs', () => {
    const a = hashLocalPart('alice', 'example.test', 'pepper-0');
    const b = hashLocalPart('bob', 'example.test', 'pepper-0');
    expect(a).not.toBe(b);
  });
});

describe('createSmtpLogger', () => {
  it('connectionStart emits whitelisted fields only', () => {
    const { entries, pino } = captureLogger();
    const now = vi.fn().mockReturnValue(1_700_000_000_000);
    const logger = createSmtpLogger({ pino, salt: 'pepper-0', now });
    logger.connectionStart({ remoteIp: '203.0.113.7', startedAtMs: 1_700_000_000_000 });
    expect(entries).toHaveLength(1);
    const { obj, msg } = entries[0] ?? {};
    expect(msg).toBe('smtp.connect');
    expect(obj).toMatchObject({
      timestamp: 1_700_000_000_000,
      sender_ip: '203.0.113.7',
      sender_ip_prefix: '203.0.113.0/24',
      sender_domain: null,
      message_size: null,
      smtp_code: 220,
      duration_ms: 0,
    });
  });

  it('rcptAccepted includes local_part_hash_first8 but NOT plain address', () => {
    const { entries, pino } = captureLogger();
    const logger = createSmtpLogger({
      pino,
      salt: 'pepper-0',
      now: () => 1_700_000_001_000,
    });
    logger.rcptAccepted({
      remoteIp: '203.0.113.7',
      startedAtMs: 1_700_000_000_000,
      localPart: 'alice',
      domain: 'tempmail.local',
    });
    const obj = entries[0]?.obj ?? {};
    expect(JSON.stringify(obj)).not.toContain('alice');
    expect(obj.local_part_hash_first8).toMatch(/^[0-9a-f]{16}$/);
    expect(obj.duration_ms).toBe(1_000);
    expect(obj.smtp_code).toBe(250);
  });

  it('rateLimited emits 452 at warn level', () => {
    const { entries, pino } = captureLogger();
    const logger = createSmtpLogger({
      pino,
      salt: 'pepper-0',
      now: () => 1_700_000_002_000,
    });
    logger.rateLimited({ remoteIp: '203.0.113.7', startedAtMs: 1_700_000_002_000 });
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.obj.smtp_code).toBe(452);
  });

  it('never emits fields outside the whitelist', () => {
    const { entries, pino } = captureLogger();
    const logger = createSmtpLogger({ pino, salt: 'pepper-0', now: () => 1_700_000_003_000 });
    logger.dataAccepted({
      remoteIp: '198.51.100.9',
      startedAtMs: 1_700_000_000_000,
      messageSize: 1234,
      senderDomain: 'example.com',
      localPart: 'bob',
      domain: 'tempmail.local',
    });
    const allowed = new Set([
      'timestamp',
      'sender_ip',
      'sender_ip_prefix',
      'sender_domain',
      'message_size',
      'smtp_code',
      'duration_ms',
      'local_part_hash_first8',
    ]);
    for (const key of Object.keys(entries[0]?.obj ?? {})) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});
