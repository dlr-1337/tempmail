/**
 * HTML sanitizer backed by isomorphic-dompurify (D-03, D-13, D-18).
 *
 * The locked policy strips `script / style / iframe / object / embed / base
 * / link` tags and event-handler attributes (`on...`) plus `style`, `srcset`,
 * `srcdoc`, `formaction`. `javascript:`, `vbscript:`, and `data:` URIs are
 * blocked by the explicit `ALLOWED_URI_REGEXP`. Remote-src `<img>` tags are
 * DELIBERATELY left intact (D-20) — the frontend iframe's CSP is what
 * actually blocks tracking pixels.
 *
 * DOMPurify initialization can be ~200ms (jsdom startup) so
 * `createHtmlSanitizer` runs once at factory time and returns a reusable
 * object.
 */

import DOMPurify from 'isomorphic-dompurify';

export interface HtmlSanitizer {
  /** Returns the sanitized HTML, or `null` if `input` is null/empty. */
  sanitize(input: string | null | undefined): string | null;
}

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'base', 'link'] as const;

const FORBID_ATTR = ['style', 'srcset', 'srcdoc', 'formaction'] as const;

// Allowed URI schemes per D-18. Blocks `javascript:`, `vbscript:`, `data:`.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function createHtmlSanitizer(): HtmlSanitizer {
  // A per-sanitizer DOMPurify hook strips:
  //   - any attribute starting with `on` (event handlers) — DOMPurify usually
  //     does this, but we belt-and-brace;
  //   - any URL-bearing attribute whose value starts with `data:` or
  //     `javascript:` / `vbscript:`. DOMPurify's default policy allows
  //     `data:image/*` in some contexts, which clashes with our D-18 lockdown.
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName.toLowerCase();
    if (name.startsWith('on')) {
      data.keepAttr = false;
      return;
    }
    if (name === 'src' || name === 'href' || name === 'xlink:href' || name === 'action') {
      const v = (data.attrValue ?? '').trim().toLowerCase();
      if (v.startsWith('data:') || v.startsWith('javascript:') || v.startsWith('vbscript:')) {
        data.keepAttr = false;
      }
    }
  });

  const sanitize = (input: string | null | undefined): string | null => {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'string') return null;
    if (input.length === 0) return '';
    return DOMPurify.sanitize(input, {
      FORBID_TAGS: [...FORBID_TAGS],
      FORBID_ATTR: [...FORBID_ATTR],
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP,
      WHOLE_DOCUMENT: false,
      RETURN_TRUSTED_TYPE: false,
    }) as string;
  };

  return { sanitize };
}
