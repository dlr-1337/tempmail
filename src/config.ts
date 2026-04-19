/**
 * Env-var config schema for the process entrypoint (`src/main.ts`).
 *
 * Phase 8 D-16: single validated shape, zod-backed. Fails fast at startup if a
 * required var is missing or malformed — `main.ts` catches the ZodError,
 * prints a user-friendly message, and exits 1. No silent coercion, no defaults
 * for security-critical fields (PII_LOG_SALT, COOKIE_SECRET).
 *
 * Design notes:
 *   - `z.coerce.number().int()` is used for ports / TTLs so `process.env.*` (all
 *     strings) becomes a real number without a manual `Number()` layer.
 *   - Boolean envs accept `'true' | 'false' | '1' | '0'` case-insensitive.
 *   - `NODE_ENV` is not required; the app doesn't branch on it (logging /
 *     crypto posture is controlled by explicit flags).
 *
 * Never imported outside `main.ts` and its unit tests — the rest of the code
 * stays factory/DI-pure.
 */

import { z } from 'zod';

/** Accepts `'true'`, `'false'`, `'1'`, `'0'` case-insensitive. */
const zBoolString = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s, ctx) => {
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be one of 'true', 'false', '1', '0'",
    });
    return z.NEVER;
  });

/** Absolute or relative path; trimmed; non-empty. */
const zPath = z.string().trim().min(1);

/** Minimum entropy we demand of security-critical secrets. */
const MIN_SECRET_LEN = 16;

export const EnvSchema = z
  .object({
    // --- required ---
    DOMAIN: z
      .string()
      .trim()
      .min(1)
      .refine((v) => !v.includes('@'), {
        message: 'DOMAIN must not contain `@`',
      }),
    PII_LOG_SALT: z.string().min(MIN_SECRET_LEN, {
      message: `PII_LOG_SALT must be at least ${MIN_SECRET_LEN} chars (use \`openssl rand -hex 32\`)`,
    }),
    COOKIE_SECRET: z.string().min(MIN_SECRET_LEN, {
      message: `COOKIE_SECRET must be at least ${MIN_SECRET_LEN} chars`,
    }),

    // --- ports / binds ---
    SMTP_PORT: z.coerce.number().int().min(0).max(65535).default(25),
    SMTP_HOST: z.string().trim().min(1).default('0.0.0.0'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HTTP_HOST: z.string().trim().min(1).default('0.0.0.0'),

    // --- retention ---
    IDLE_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(10 * 60 * 1000),
    HARD_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(60 * 60 * 1000),

    // --- data paths ---
    DATA_DIR: zPath.default('/data'),
    DB_PATH: zPath.optional(),
    ATTACHMENTS_DIR: zPath.optional(),

    // --- TLS / SMTP ---
    TLS_CERT_PATH: zPath.optional(),
    TLS_KEY_PATH: zPath.optional(),
    TLS_DEV_SELF_SIGNED: zBoolString.default('false'),
    MAX_MESSAGE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(10 * 1024 * 1024),
    SMTP_TOKENS_PER_MINUTE: z.coerce.number().int().positive().default(10),
    SMTP_BURST: z.coerce.number().int().positive().default(20),
    SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
    SMTP_CLOSE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),

    // --- admin ---
    ADMIN_ENABLED: zBoolString.default('false'),

    // --- misc ---
    LETS_ENCRYPT_EMAIL: z.string().email().optional(),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  })
  .superRefine((env, ctx) => {
    if (env.HARD_TTL_MS < env.IDLE_TTL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HARD_TTL_MS'],
        message: 'HARD_TTL_MS must be >= IDLE_TTL_MS',
      });
    }
    // TLS: either both paths set, or dev self-signed enabled, or neither (then
    // SMTP runs without STARTTLS — the SMTP config validator will reject that).
    const hasCert = Boolean(env.TLS_CERT_PATH) && Boolean(env.TLS_KEY_PATH);
    if (!hasCert && !env.TLS_DEV_SELF_SIGNED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TLS_CERT_PATH'],
        message:
          'Either provide both TLS_CERT_PATH and TLS_KEY_PATH, or set TLS_DEV_SELF_SIGNED=true (dev-only)',
      });
    }
    if (Boolean(env.TLS_CERT_PATH) !== Boolean(env.TLS_KEY_PATH)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TLS_KEY_PATH'],
        message: 'TLS_CERT_PATH and TLS_KEY_PATH must be set together',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Materialized, typed configuration derived from a parsed `Env`. This is what
 * `main.ts` passes to each factory.
 */
export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  domain: string;
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  retention: {
    idleTtlMs: number;
    hardTtlMs: number;
  };
  smtp: {
    port: number;
    host: string;
    maxMessageBytes: number;
    tokensPerMinute: number;
    burst: number;
    socketTimeoutMs: number;
    closeTimeoutMs: number;
    tlsCertPath: string | undefined;
    tlsKeyPath: string | undefined;
    tlsDevSelfSigned: boolean;
    piiLogSalt: string;
  };
  http: {
    port: number;
    host: string;
    cookieSecret: string;
    adminEnabled: boolean;
  };
}

/**
 * Parses `process.env` (or any record) into a validated Env, then materializes
 * the `AppConfig` shape the composition root consumes. Throws `z.ZodError` on
 * failure — callers should pretty-print via `formatEnvErrors`.
 */
export function loadAppConfig(
  raw: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AppConfig {
  const env = EnvSchema.parse(raw);
  const dataDir = env.DATA_DIR;
  const dbPath = env.DB_PATH ?? `${trimTrailingSlash(dataDir)}/tempmail.db`;
  const attachmentsDir = env.ATTACHMENTS_DIR ?? `${trimTrailingSlash(dataDir)}/attachments`;

  return {
    nodeEnv: env.NODE_ENV,
    domain: env.DOMAIN,
    dataDir,
    dbPath,
    attachmentsDir,
    retention: {
      idleTtlMs: env.IDLE_TTL_MS,
      hardTtlMs: env.HARD_TTL_MS,
    },
    smtp: {
      port: env.SMTP_PORT,
      host: env.SMTP_HOST,
      maxMessageBytes: env.MAX_MESSAGE_BYTES,
      tokensPerMinute: env.SMTP_TOKENS_PER_MINUTE,
      burst: env.SMTP_BURST,
      socketTimeoutMs: env.SMTP_SOCKET_TIMEOUT_MS,
      closeTimeoutMs: env.SMTP_CLOSE_TIMEOUT_MS,
      tlsCertPath: env.TLS_CERT_PATH,
      tlsKeyPath: env.TLS_KEY_PATH,
      tlsDevSelfSigned: env.TLS_DEV_SELF_SIGNED,
      piiLogSalt: env.PII_LOG_SALT,
    },
    http: {
      port: env.HTTP_PORT,
      host: env.HTTP_HOST,
      cookieSecret: env.COOKIE_SECRET,
      adminEnabled: env.ADMIN_ENABLED,
    },
  };
}

function trimTrailingSlash(p: string): string {
  return p.endsWith('/') || p.endsWith('\\') ? p.slice(0, -1) : p;
}

/**
 * Turns a `z.ZodError` into a list of `KEY: message` lines so main.ts can
 * print a friendly multi-line startup failure.
 */
export function formatEnvErrors(err: z.ZodError): string[] {
  return err.errors.map((e) => {
    const key = e.path.length > 0 ? e.path.join('.') : '(root)';
    return `${key}: ${e.message}`;
  });
}
