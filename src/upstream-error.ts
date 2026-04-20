/**
 * SEC-F07: extract only the OAuth-standard safe fields from an upstream error
 * body. Logging the raw payload would echo correlation IDs, trace fragments,
 * or unexpected server-generated content that has no place in our logs.
 *
 * Pure function so it can be unit-tested without pulling the Express / OAuth
 * proxy module. Kept deliberately small: `error`, `error_description`, and
 * `error_codes` are the only fields defined by RFC 6749 §5.2 plus the Microsoft
 * `error_codes` extension that help operators debug legitimate issues.
 */
export function summarizeUpstreamError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      error_description?: unknown;
      error_codes?: unknown;
    };
    const parts: string[] = [];
    if (typeof parsed.error === 'string') parts.push(`error=${parsed.error}`);
    if (typeof parsed.error_description === 'string') {
      // Trim whitespace and clip — error_description can be a short sentence
      // but should never be an essay in our logs.
      const clipped = parsed.error_description.replace(/\s+/g, ' ').slice(0, 200);
      parts.push(`error_description="${clipped}"`);
    }
    if (Array.isArray(parsed.error_codes)) {
      const codes = parsed.error_codes.filter((c) => typeof c === 'number').slice(0, 5);
      if (codes.length > 0) parts.push(`error_codes=[${codes.join(',')}]`);
    }
    return parts.length > 0 ? parts.join(' ') : '<no recognised oauth error fields>';
  } catch {
    return `<unparseable ${body.length} bytes>`;
  }
}
