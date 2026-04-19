/**
 * API base URL. Defaults to '/api' (same-origin under Caddy in Phase 8).
 * Override at build time: VITE_API_BASE=http://localhost:8080/api
 */
export const API_BASE: string =
  (import.meta.env?.VITE_API_BASE as string | undefined) ?? '/api';
