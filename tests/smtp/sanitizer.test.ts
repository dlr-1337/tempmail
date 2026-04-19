/**
 * HTML sanitizer coverage (Phase 4 CONTEXT D-18/D-19/D-20).
 */

import { describe, expect, it } from 'vitest';
import { createHtmlSanitizer } from '../../src/smtp/sanitizer.js';

describe('createHtmlSanitizer', () => {
  const sanitizer = createHtmlSanitizer();

  it('returns null for null/undefined and empty for empty', () => {
    expect(sanitizer.sanitize(null)).toBeNull();
    expect(sanitizer.sanitize(undefined)).toBeNull();
    expect(sanitizer.sanitize('')).toBe('');
  });

  it('strips script tags', () => {
    const out = sanitizer.sanitize('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>hi</p>');
  });

  it('strips style and iframe and object', () => {
    const out = sanitizer.sanitize(
      '<style>x{}</style><iframe src="//x"></iframe><object data="x"></object>',
    );
    expect(out).not.toMatch(/<(style|iframe|object)/i);
  });

  it('strips link and base', () => {
    const out = sanitizer.sanitize(
      '<link rel="stylesheet" href="//a/x.css"><base href="//attacker"><p>x</p>',
    );
    expect(out).not.toMatch(/<(link|base)/i);
  });

  it('strips event-handler attributes (on*)', () => {
    const out = sanitizer.sanitize('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  it('strips javascript: URIs', () => {
    const out = sanitizer.sanitize('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
  });

  it('strips data: URIs in img src', () => {
    const out = sanitizer.sanitize('<img src="data:image/png;base64,AAAA">');
    // Either the whole tag drops or just the attr; both acceptable as long as
    // no `data:` substring survives.
    expect(out).not.toContain('data:image');
  });

  it('preserves remote-src img tags (D-20)', () => {
    const out = sanitizer.sanitize('<img src="https://remote.example/pixel.png">');
    expect(out).toMatch(/<img[^>]+src="https:\/\/remote\.example/);
  });

  it('strips style attributes even on allowed tags', () => {
    const out = sanitizer.sanitize('<p style="color:red">hi</p>');
    expect(out).not.toContain('style=');
    expect(out).toContain('<p>hi</p>');
  });

  it('strips srcdoc and formaction', () => {
    const out = sanitizer.sanitize(
      '<iframe srcdoc="<script>a</script>"></iframe><button formaction="javascript:a">b</button>',
    );
    expect(out).not.toContain('srcdoc');
    expect(out).not.toContain('formaction');
    expect(out).not.toContain('<script');
  });
});
