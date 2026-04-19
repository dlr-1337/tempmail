/**
 * Tiny line-oriented SMTP client — just enough to drive the Phase 4 server
 * from tests without pulling in the full nodemailer client.
 *
 * Usage:
 *   const c = await connect({ port });
 *   const greeting = await c.read();          // 220 ...
 *   const r = await c.command('EHLO tester'); // returns array of reply lines
 *   await c.close();
 */

import { type Socket, createConnection } from 'node:net';

export interface SmtpTextClient {
  read(): Promise<string[]>;
  command(line: string): Promise<string[]>;
  writeRaw(bytes: Buffer | string): void;
  /** Blocks until the server has sent `predicate` satisfying reply. */
  close(): Promise<void>;
}

export interface ConnectOpts {
  port: number;
  host?: string;
}

const LINE_END = '\r\n';

export async function connect(opts: ConnectOpts): Promise<SmtpTextClient> {
  const socket = createConnection({ host: opts.host ?? '127.0.0.1', port: opts.port });
  await once(socket, 'connect');

  const lineQueue: string[][] = [];
  let pendingResolve: ((lines: string[]) => void) | null = null;

  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    // Split by CRLF; collect a full reply group (lines ending with "NNN " not "NNN -").
    let eol = buffer.indexOf(LINE_END);
    const group: string[] = [];
    // Peek existing queue to append mid-reply lines if needed.
    let cursor = 0;
    while (eol >= 0) {
      const line = buffer.slice(cursor, eol);
      group.push(line);
      cursor = eol + 2;
      eol = buffer.indexOf(LINE_END, cursor);
    }
    buffer = buffer.slice(cursor);

    // Now split `group` into full replies by trailing-space rule.
    let replyStart = 0;
    for (let i = 0; i < group.length; i++) {
      const line = group[i] ?? '';
      const code = line.slice(0, 3);
      const sep = line.charAt(3);
      if (/^\d{3}$/.test(code) && sep === ' ') {
        const full = group.slice(replyStart, i + 1);
        replyStart = i + 1;
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r(full);
        } else {
          lineQueue.push(full);
        }
      }
    }
  });

  const read = (): Promise<string[]> => {
    const existing = lineQueue.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<string[]>((resolve) => {
      pendingResolve = resolve;
    });
  };

  const command = async (line: string): Promise<string[]> => {
    socket.write(`${line}${LINE_END}`);
    return read();
  };

  const writeRaw = (bytes: Buffer | string): void => {
    socket.write(bytes);
  };

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
      // Fallback destroy if the peer doesn't close promptly.
      setTimeout(() => socket.destroy(), 500).unref();
    });
  };

  return { read, command, writeRaw, close };
}

function once(s: Socket, event: 'connect'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error): void => {
      s.off(event, onOk);
      reject(err);
    };
    const onOk = (): void => {
      s.off('error', onErr);
      resolve();
    };
    s.once(event, onOk);
    s.once('error', onErr);
  });
}
