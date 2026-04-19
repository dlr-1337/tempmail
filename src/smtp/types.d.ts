/**
 * Ambient type declaration for `smtp-server` (Nodemailer) — the upstream package
 * does not ship its own `.d.ts`. This file covers only the surface we actually
 * consume in the Phase 4 adapter (D-01); full coverage of every handler/option
 * is explicitly out of scope.
 */

declare module 'smtp-server' {
  import type { AddressInfo, Server as NetServer } from 'node:net';
  import type { Readable } from 'node:stream';
  import type { TlsOptions } from 'node:tls';

  export interface SMTPServerAddress {
    /** Full `local@domain`. */
    readonly address: string;
    readonly args: Record<string, string>;
  }

  export interface SMTPServerEnvelope {
    mailFrom: SMTPServerAddress | false;
    rcptTo: SMTPServerAddress[];
  }

  export interface SMTPServerSession {
    readonly id: string;
    readonly remoteAddress: string;
    readonly remotePort: number;
    readonly clientHostname: string;
    readonly openingCommand: string;
    readonly hostNameAppearsAs: string;
    readonly envelope: SMTPServerEnvelope;
    readonly user?: string;
    readonly transaction: number;
    readonly transmissionType: string;
    readonly tlsOptions?: TlsOptions;
    readonly secure?: boolean;
  }

  /** Error subclass-shape smtp-server recognizes — set `responseCode` to drive
   *  SMTP status codes (e.g. 452, 550, 552). Any `Error` with a numeric
   *  `responseCode` works; smtp-server reads it off the thrown/passed value. */
  export interface SMTPResponseError extends Error {
    responseCode?: number;
  }

  /** The readable handed to `onData`. It's a passthrough of the DATA stream
   *  with a `sizeExceeded: boolean` flag set on `end` when the message exceeded
   *  the configured `size` cap. */
  export interface SMTPServerDataStream extends Readable {
    readonly sizeExceeded?: boolean;
    readonly byteLength?: number;
  }

  export type OnConnectCallback = (err?: Error | null) => void;
  export type OnSecureCallback = (err?: Error | null) => void;
  export type OnAuthCallback = (err?: Error | null, response?: { user?: string }) => void;
  export type OnMailFromCallback = (err?: Error | null) => void;
  export type OnRcptToCallback = (err?: Error | null) => void;
  export type OnDataCallback = (err?: Error | null, message?: string) => void;
  export type OnCloseCallback = (err?: Error | null) => void;

  export interface SMTPServerOptions extends TlsOptions {
    /** Optional server-level identifiers. */
    name?: string;
    banner?: string;
    /** SMTP vs LMTP. We only use SMTP. */
    lmtp?: boolean;
    /** Upper size cap in bytes (advertised via EHLO SIZE). */
    size?: number;
    /** Hide STARTTLS capability from EHLO output. We want this false. */
    hideSTARTTLS?: boolean;
    /** When true, any command that would normally require AUTH is permitted
     *  unauthenticated. We pair this with `disabledCommands: ['AUTH']`. */
    authOptional?: boolean;
    /** Accept/reject specific commands outright. */
    disabledCommands?: string[];
    /** Supported auth mechanisms. We don't use any. */
    authMethods?: string[];
    /** SMTP socket is already TLS when true. For STARTTLS we leave this false. */
    secure?: boolean;
    needsUpgrade?: boolean;

    /** Idle socket timeout in ms. */
    socketTimeout?: number;
    /** Grace period on `.close()` in ms. */
    closeTimeout?: number;

    /** If true, smtp-server attaches a nodemailer-style logger. We leave it
     *  `false` and attach our own pino via `logger` directly if needed. */
    logger?:
      | boolean
      | {
          info: (...a: unknown[]) => void;
          debug: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          error: (...a: unknown[]) => void;
        };

    onConnect?: (session: SMTPServerSession, cb: OnConnectCallback) => void;
    onSecure?: (socket: unknown, session: SMTPServerSession, cb: OnSecureCallback) => void;
    onAuth?: (
      auth: { method: string; username?: string; password?: string },
      session: SMTPServerSession,
      cb: OnAuthCallback,
    ) => void;
    onMailFrom?: (
      address: SMTPServerAddress,
      session: SMTPServerSession,
      cb: OnMailFromCallback,
    ) => void;
    onRcptTo?: (
      address: SMTPServerAddress,
      session: SMTPServerSession,
      cb: OnRcptToCallback,
    ) => void;
    onData?: (stream: SMTPServerDataStream, session: SMTPServerSession, cb: OnDataCallback) => void;
    onClose?: (session: SMTPServerSession, cb?: OnCloseCallback) => void;
  }

  export class SMTPServer {
    constructor(options?: SMTPServerOptions);
    readonly options: SMTPServerOptions;
    readonly server: NetServer;
    listen(port?: number, hostname?: string, listeningListener?: () => void): NetServer;
    listen(port?: number, listeningListener?: () => void): NetServer;
    close(callback?: () => void): void;
    address(): AddressInfo | string | null;
    updateSecureContext(options?: TlsOptions): void;
    // EventEmitter-compat subset we actually use. Full EE surface is not
    // inherited here because `declare module` + external inheritance confuses
    // Biome's unused-import analyzer. This subset is enough for `.on('error', ...)`
    // style calls.
    on(event: string, listener: (...args: unknown[]) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
  }
}
