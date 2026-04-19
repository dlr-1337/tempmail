# Plan 04-01 Summary — Scaffolding

## Delivered
- Runtime deps: `smtp-server@^3`, `mailparser@^3`, `isomorphic-dompurify@^2`, `selfsigned@^5`.
- Dev types: `@types/nodemailer`, `@types/mailparser`.
- `src/smtp/types.d.ts` — ambient `declare module 'smtp-server'` covering the
  surface Phase 4 actually consumes (SMTPServer, options, session, address,
  handler callback shapes). No upstream @types exists; this file is the single
  source of truth for smtp-server types inside the project.

## Notes
- Biome struggles with `extends EventEmitter` inside `declare module` blocks
  (unused-import false positive), so the ambient class declares only the
  subset of EventEmitter methods we call (`on`/`off`/`once`/`emit`).
- `selfsigned@5` is async; drove a downstream change to make
  `createSmtpServer` itself async (see plan 04-02 summary).

## Verification
- `npm run typecheck` exits 0.
- `npm run check` exits 0.

## Commit
`chore(04): install smtp-server, mailparser, dompurify and add ambient types`
