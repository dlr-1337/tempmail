import { describe, expect, it } from 'vitest';
import { isValidSha256Hex, shardPath } from '../../src/attachments/paths.js';

describe('attachment paths (STORE-03)', () => {
  const hex = `de01ad02${'0'.repeat(56)}`;

  it('shardPath returns <aa>/<bb>/<sha256>', () => {
    expect(shardPath(hex)).toBe(`de/01/${hex}`);
  });

  it('shardPath throws on invalid hex', () => {
    expect(() => shardPath('short')).toThrow();
    expect(() => shardPath(hex.toUpperCase())).toThrow();
    expect(() => shardPath('z'.repeat(64))).toThrow();
  });

  it('isValidSha256Hex rejects non-lowercase, wrong length, non-hex', () => {
    expect(isValidSha256Hex(hex)).toBe(true);
    expect(isValidSha256Hex('')).toBe(false);
    expect(isValidSha256Hex(hex.slice(1))).toBe(false); // 63 chars
    expect(isValidSha256Hex(`${hex}a`)).toBe(false); // 65 chars
    expect(isValidSha256Hex(`DE${hex.slice(2)}`)).toBe(false); // uppercase
    expect(isValidSha256Hex(`gg${hex.slice(2)}`)).toBe(false); // non-hex
  });

  it('isValidSha256Hex accepts all lowercase hex digits', () => {
    expect(isValidSha256Hex('0123456789abcdef'.repeat(4))).toBe(true);
  });
});
