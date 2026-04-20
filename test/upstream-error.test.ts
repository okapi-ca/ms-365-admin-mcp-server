import { describe, it, expect } from 'vitest';
import { summarizeUpstreamError } from '../src/upstream-error.js';

describe('summarizeUpstreamError', () => {
  it('extracts error and error_description from a well-formed OAuth error JSON', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      error_description: 'AADSTS70008: The provided authorization code has expired.',
      correlation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      trace_id: '11111111-2222-3333-4444-555555555555',
    });
    const out = summarizeUpstreamError(body);
    expect(out).toContain('error=invalid_grant');
    expect(out).toContain('error_description="AADSTS70008');
    expect(out).not.toContain('correlation_id');
    expect(out).not.toContain('trace_id');
  });

  it('includes up to five numeric error_codes', () => {
    const body = JSON.stringify({
      error: 'invalid_request',
      error_codes: [70008, 70011, 'not-a-number', 90014, 70044, 12345, 67890],
    });
    const out = summarizeUpstreamError(body);
    expect(out).toContain('error_codes=[70008,70011,90014,70044,12345]');
  });

  it('clips a long error_description to 200 characters and collapses whitespace', () => {
    const longDescription = 'A'.repeat(250);
    const body = JSON.stringify({ error: 'invalid_grant', error_description: longDescription });
    const out = summarizeUpstreamError(body);
    const match = out.match(/error_description="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(200);
  });

  it('collapses embedded newlines and tabs in error_description', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      error_description: 'line one\n\tline two\r\n  line three',
    });
    const out = summarizeUpstreamError(body);
    expect(out).toContain('error_description="line one line two line three"');
  });

  it('returns an unparseable marker with byte length for non-JSON bodies', () => {
    const out = summarizeUpstreamError('<html><body>502 Bad Gateway</body></html>');
    expect(out).toMatch(/^<unparseable \d+ bytes>$/);
  });

  it('returns a sentinel when the JSON parses but has no recognised fields', () => {
    const out = summarizeUpstreamError(JSON.stringify({ something_else: 'value' }));
    expect(out).toBe('<no recognised oauth error fields>');
  });

  it('ignores non-string error and error_description values', () => {
    const out = summarizeUpstreamError(
      JSON.stringify({ error: { nested: 'object' }, error_description: 42 })
    );
    expect(out).toBe('<no recognised oauth error fields>');
  });
});
