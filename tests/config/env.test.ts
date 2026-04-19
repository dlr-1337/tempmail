/**
 * Env schema unit tests (Phase 8, D-16).
 *
 * `loadAppConfig` is pure over its input (no fs / net / env reads), so we
 * feed it record literals and assert both the happy path and each guardrail.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatEnvErrors, loadAppConfig } from '../../src/config.js';

const minValid: Record<string, string> = {
  DOMAIN: 'tempmail.local',
  PII_LOG_SALT: 'x'.repeat(32),
  COOKIE_SECRET: 'y'.repeat(32),
  TLS_DEV_SELF_SIGNED: 'true',
};

describe('loadAppConfig', () => {
  it('accepts the minimum viable env and applies defaults', () => {
    const cfg = loadAppConfig(minValid);
    expect(cfg.domain).toBe('tempmail.local');
    expect(cfg.smtp.port).toBe(25);
    expect(cfg.http.port).toBe(8080);
    expect(cfg.retention.idleTtlMs).toBe(10 * 60 * 1000);
    expect(cfg.retention.hardTtlMs).toBe(60 * 60 * 1000);
    expect(cfg.smtp.tlsDevSelfSigned).toBe(true);
    expect(cfg.dataDir).toBe('/data');
    expect(cfg.dbPath).toBe('/data/tempmail.db');
    expect(cfg.attachmentsDir).toBe('/data/attachments');
    expect(cfg.http.adminEnabled).toBe(false);
    expect(cfg.nodeEnv).toBe('production');
  });

  it('coerces numeric envs from strings', () => {
    const cfg = loadAppConfig({
      ...minValid,
      SMTP_PORT: '2525',
      HTTP_PORT: '9090',
      IDLE_TTL_MS: '120000',
      HARD_TTL_MS: '600000',
    });
    expect(cfg.smtp.port).toBe(2525);
    expect(cfg.http.port).toBe(9090);
    expect(cfg.retention.idleTtlMs).toBe(120_000);
    expect(cfg.retention.hardTtlMs).toBe(600_000);
  });

  it('rejects HARD_TTL_MS < IDLE_TTL_MS', () => {
    try {
      loadAppConfig({ ...minValid, IDLE_TTL_MS: '600000', HARD_TTL_MS: '300000' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(z.ZodError);
      const msg = formatEnvErrors(e as z.ZodError).join('\n');
      expect(msg).toMatch(/HARD_TTL_MS/);
    }
  });

  it('rejects short PII_LOG_SALT', () => {
    try {
      loadAppConfig({ ...minValid, PII_LOG_SALT: 'short' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(z.ZodError);
      const msg = formatEnvErrors(e as z.ZodError).join('\n');
      expect(msg).toMatch(/PII_LOG_SALT/);
    }
  });

  it('rejects short COOKIE_SECRET', () => {
    try {
      loadAppConfig({ ...minValid, COOKIE_SECRET: 'short' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(z.ZodError);
      const msg = formatEnvErrors(e as z.ZodError).join('\n');
      expect(msg).toMatch(/COOKIE_SECRET/);
    }
  });

  it('rejects domain containing @', () => {
    try {
      loadAppConfig({ ...minValid, DOMAIN: 'bad@domain' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(z.ZodError);
    }
  });

  it('requires either TLS paths or dev self-signed', () => {
    const { TLS_DEV_SELF_SIGNED: _omit, ...env } = minValid;
    try {
      loadAppConfig(env);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(z.ZodError);
      const msg = formatEnvErrors(e as z.ZodError).join('\n');
      expect(msg).toMatch(/TLS/);
    }
  });

  it('rejects half-configured TLS (cert without key)', () => {
    try {
      loadAppConfig({
        ...minValid,
        TLS_DEV_SELF_SIGNED: 'false',
        TLS_CERT_PATH: '/etc/tls/fullchain.pem',
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(z.ZodError);
      const msg = formatEnvErrors(e as z.ZodError).join('\n');
      expect(msg).toMatch(/TLS/);
    }
  });

  it('accepts TLS paths when both supplied', () => {
    const cfg = loadAppConfig({
      ...minValid,
      TLS_DEV_SELF_SIGNED: 'false',
      TLS_CERT_PATH: '/etc/tls/fullchain.pem',
      TLS_KEY_PATH: '/etc/tls/privkey.pem',
    });
    expect(cfg.smtp.tlsCertPath).toBe('/etc/tls/fullchain.pem');
    expect(cfg.smtp.tlsKeyPath).toBe('/etc/tls/privkey.pem');
    expect(cfg.smtp.tlsDevSelfSigned).toBe(false);
  });

  it('derives DB_PATH / ATTACHMENTS_DIR from DATA_DIR when not set', () => {
    const cfg = loadAppConfig({ ...minValid, DATA_DIR: '/srv/tempmail' });
    expect(cfg.dbPath).toBe('/srv/tempmail/tempmail.db');
    expect(cfg.attachmentsDir).toBe('/srv/tempmail/attachments');
  });

  it('honors explicit DB_PATH / ATTACHMENTS_DIR overrides', () => {
    const cfg = loadAppConfig({
      ...minValid,
      DATA_DIR: '/srv/tempmail',
      DB_PATH: '/var/lib/db.sqlite',
      ATTACHMENTS_DIR: '/var/lib/att',
    });
    expect(cfg.dbPath).toBe('/var/lib/db.sqlite');
    expect(cfg.attachmentsDir).toBe('/var/lib/att');
  });

  it('parses ADMIN_ENABLED boolean', () => {
    const cfg = loadAppConfig({ ...minValid, ADMIN_ENABLED: '1' });
    expect(cfg.http.adminEnabled).toBe(true);
  });

  it('formats zod errors as readable lines', () => {
    try {
      loadAppConfig({});
      expect.fail('should have thrown');
    } catch (e) {
      const lines = formatEnvErrors(e as z.ZodError);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => typeof l === 'string' && l.includes(':'))).toBe(true);
    }
  });
});
