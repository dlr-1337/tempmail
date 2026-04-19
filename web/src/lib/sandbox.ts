/**
 * Build the srcdoc for the sandboxed HTML iframe.
 *
 * The iframe element is rendered with sandbox="allow-popups" (no allow-scripts,
 * no allow-same-origin). The CSP <meta> below is defense-in-depth: it blocks
 * script execution, XHR/fetch, and (by default) remote images.
 *
 * "Load images" is per-message only — callers must NOT persist the toggle across
 * messages. See Phase 7 D-28.
 */

export interface BuildSrcdocOptions {
  /** When true, CSP allows https: images. Default false. */
  allowRemoteImages: boolean;
}

const BASE_STYLE = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:8px;color:#111;line-height:1.5;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#2563eb}`;

export function buildSrcdoc(
  sanitizedHtml: string,
  opts: BuildSrcdocOptions
): string {
  const csp = buildCsp(opts.allowRemoteImages);
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<style>${BASE_STYLE}</style>` +
    '</head><body>' +
    sanitizedHtml +
    '</body></html>'
  );
}

export function buildCsp(allowRemoteImages: boolean): string {
  const imgSrc = allowRemoteImages ? 'data: https:' : 'data:';
  return [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
}
