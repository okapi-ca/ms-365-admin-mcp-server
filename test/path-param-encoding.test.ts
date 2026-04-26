import { describe, it, expect } from 'vitest';
import { encodePathParamValue } from '../src/graph-tools.js';

describe('SEC-006 — path-param encoding (non-skipEncoding branch)', () => {
  describe('regression — user-supplied = stays encoded', () => {
    it.each([
      'alice@example.com=admin',
      'foo=bar',
      "x'=' OR '1'='1",
      'normal=value=with=many=equals',
    ])('encodes literal = in %j as %%3D', (input) => {
      const out = encodePathParamValue(input);
      expect(out).not.toContain('=');
      expect(out).toContain('%3D');
    });
  });

  describe('standard encoding behavior preserved', () => {
    it('encodes @ as %40 (e.g. UPN in path)', () => {
      expect(encodePathParamValue('alice@example.com')).toBe('alice%40example.com');
    });

    it('encodes / as %2F', () => {
      expect(encodePathParamValue('foo/bar')).toBe('foo%2Fbar');
    });

    it('encodes spaces as %20', () => {
      expect(encodePathParamValue('foo bar')).toBe('foo%20bar');
    });

    it('passes through GUIDs unchanged', () => {
      const guid = '12345678-1234-1234-1234-123456789abc';
      expect(encodePathParamValue(guid)).toBe(guid);
    });

    it('passes through unreserved RFC 3986 characters', () => {
      expect(encodePathParamValue('A-Z.a-z_0-9~')).toBe('A-Z.a-z_0-9~');
    });
  });

  describe('cannot be coerced into path injection', () => {
    it.each([
      "user'); DROP TABLE x;--",
      'user\x00null',
      'user\nnewline',
      '../etc/passwd',
      'user&filter=$true',
      'user?$expand=manager',
    ])('encodes injection-style input %j without leaving structural chars', (input) => {
      const out = encodePathParamValue(input);
      // None of these structural chars survive raw in the output
      for (const ch of ['/', '?', '#', '&', '=', '\n', '\x00']) {
        expect(out).not.toContain(ch);
      }
    });
  });
});
