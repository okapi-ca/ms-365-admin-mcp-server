import { describe, it, expect } from 'vitest';
import { SKIP_ENCODING_ALLOWLIST, validateSkipEncodingValue } from '../src/graph-tools.js';

describe('SEC-001 — skipEncoding allowlist', () => {
  describe('accepts current legitimate values', () => {
    it.each(['D7', 'D30', 'D90', 'D180'])('accepts period value %s', (value) => {
      expect(() => validateSkipEncodingValue('period', value)).not.toThrow();
      expect(SKIP_ENCODING_ALLOWLIST.test(value)).toBe(true);
    });

    it.each(['2026-04-26T00:00:00Z', '2026-04-26T10:30:45.123Z', '2025-12-31T23:59:59.999Z'])(
      'accepts ISO 8601 datetime %s',
      (value) => {
        expect(() => validateSkipEncodingValue('fromDateTime', value)).not.toThrow();
        expect(SKIP_ENCODING_ALLOWLIST.test(value)).toBe(true);
      }
    );
  });

  describe('rejects literal path traversal (regression)', () => {
    it.each(['../etc/passwd', '..', '../../users', 'foo/../bar'])(
      'rejects literal traversal %s',
      (value) => {
        expect(() => validateSkipEncodingValue('period', value)).toThrow(
          /contains disallowed characters/
        );
      }
    );
  });

  describe('rejects percent-encoded traversal (the SEC-001 vector)', () => {
    it.each([
      '%2E%2E%2Fetc%2Fpasswd', // ../etc/passwd encoded
      '%2E%2E', // .. encoded
      '%2E%2E%2F', // ../ encoded
      '%2F', // / encoded
      '%5C', // \ encoded
      'D7%2E%2E', // legitimate prefix + encoded traversal
    ])('rejects percent-encoded value %s', (value) => {
      expect(() => validateSkipEncodingValue('period', value)).toThrow(
        /contains disallowed characters/
      );
    });
  });

  describe('rejects other disallowed characters', () => {
    it.each([
      '', // empty
      'foo bar', // space
      'foo&bar', // query separator
      'foo?bar', // query mark
      'foo#bar', // fragment
      "alice'or'1", // quote
      'foo\nbar', // newline
      'foo\tbar', // tab
      'foo\x00bar', // null byte
      'foo|bar', // pipe
      'foo$bar', // dollar
    ])('rejects %j', (value) => {
      expect(() => validateSkipEncodingValue('period', value)).toThrow(
        /contains disallowed characters/
      );
    });
  });

  describe('error message includes parameter name', () => {
    it('surfaces the param name for diagnostics', () => {
      expect(() => validateSkipEncodingValue('fromDateTime', '../foo')).toThrow(/'fromDateTime'/);
    });
  });
});
