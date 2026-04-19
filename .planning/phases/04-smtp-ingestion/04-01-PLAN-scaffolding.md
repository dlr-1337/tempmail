---
phase: 4
plan: 1
status: ready
type: execute
wave: 1
depends_on: []
requirements: []
files_modified:
  - package.json
  - package-lock.json
  - src/smtp/types.d.ts
autonomous: true
tags: [smtp, scaffolding, deps]
---

## Goal

Install Phase 4 runtime dependencies (`smtp-server`, `mailparser`, `isomorphic-dompurify`) and their type support. Provide ambient type declarations for `smtp-server` (no upstream @types package exists) so every subsequent plan can import it under `--strict`.

## Must-have checklist

- [x] `smtp-server@^3` is a runtime dep
- [x] `mailparser@^3` is a runtime dep
- [x] `isomorphic-dompurify@^2` is a runtime dep
- [x] `@types/nodemailer` and `@types/mailparser` are dev deps
- [x] `src/smtp/types.d.ts` declares a minimal `'smtp-server'` module type covering the surface we actually use (`SMTPServer`, `SMTPServerOptions`, `SMTPServerSession`, `SMTPServerAddress`, `SMTPServerDataStream`)
- [x] `npm run typecheck` exits 0 with the ambient decl in place

## Tasks

1. `<automated>` `npm install smtp-server@^3 mailparser@^3 isomorphic-dompurify@^2` + `npm install --save-dev @types/nodemailer @types/mailparser` — verify: `node -e "require('smtp-server')"` exits 0.
2. Write `src/smtp/types.d.ts` with a `declare module 'smtp-server'` block covering the constructor options, handler signatures, and `listen/close/on` methods used by plan 04-02/04/05.
3. `<automated>` verify: `npm run typecheck`.

Commit: `chore(04): install smtp-server, mailparser, dompurify and add smtp-server ambient types`.

## Verification

- `npm ls smtp-server mailparser isomorphic-dompurify` shows expected majors.
- `npm run typecheck` exits 0.
