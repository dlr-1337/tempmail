import { describe, expect, it } from 'vitest';
import { buildCsp, buildSrcdoc } from './sandbox.js';

describe('buildCsp', () => {
  it('blocks remote images by default', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data:');
    expect(csp).not.toContain('img-src data: https:');
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  it('permits https images only when explicitly enabled', () => {
    const csp = buildCsp(true);
    expect(csp).toContain('img-src data: https:');
  });

  it('includes hard-stop directives against scripts and forms', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // script-src is NOT explicitly set — it inherits from default-src 'none'.
  });
});

describe('buildSrcdoc', () => {
  it('preserves (does not sanitize) the caller-provided HTML — Phase 4 sanitizes upstream', () => {
    const payload = '<script>alert(1)</script><p>hi</p>';
    const doc = buildSrcdoc(payload, { allowRemoteImages: false });
    // Literal script tag remains — but CSP blocks it from executing.
    expect(doc).toContain('<script>alert(1)</script>');
    expect(doc).toContain("default-src 'none'");
  });

  it('emits the CSP meta tag before the body', () => {
    const doc = buildSrcdoc('<p>x</p>', { allowRemoteImages: false });
    const cspIdx = doc.indexOf('Content-Security-Policy');
    const bodyIdx = doc.indexOf('<body>');
    expect(cspIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(cspIdx);
  });

  it('blocks tracking pixels by default', () => {
    const doc = buildSrcdoc('<img src="https://tracker.example/pixel.gif">', {
      allowRemoteImages: false
    });
    // The img tag is literal; the CSP meta blocks the request.
    expect(doc).toContain('https://tracker.example/pixel.gif');
    expect(doc).toContain('img-src data:');
    expect(doc).not.toContain('img-src data: https:');
  });

  it('permits remote images after opt-in', () => {
    const doc = buildSrcdoc('<img src="https://example.com/hero.jpg">', {
      allowRemoteImages: true
    });
    expect(doc).toContain('img-src data: https:');
  });

  it('emits a valid doctype + html wrapper', () => {
    const doc = buildSrcdoc('<p>x</p>', { allowRemoteImages: false });
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<html>');
    expect(doc).toContain('</html>');
  });
});
