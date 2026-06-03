import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { coerceJsonStringBody } from '../src/graph-tools.js';

// Node 18 lacks the File global referenced by generated Zod schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!globalThis.File) (globalThis as any).File = Blob;

/**
 * SEC-F (handoff Finding 3): recursive Graph entity bodies are generated as
 * z.lazy(...) schemas. Some MCP clients cannot render a JSON Schema for a lazy
 * parameter and send `body` as a JSON *string*, which Zod then rejects with
 * "expected object, received string". coerceJsonStringBody() parses an
 * object/array-looking string before validation while leaving every other shape
 * untouched.
 */
describe('coerceJsonStringBody', () => {
  // Mirrors the shape of a lazy Graph entity body (e.g. ediscoverySearch):
  // the failing real-world case from the Loi 25 DSAR session.
  const lazyObjectSchema = z.lazy(() =>
    z
      .object({
        displayName: z.string().nullish(),
        contentQuery: z.string().nullish(),
        dataSourceScopes: z.string().optional(),
      })
      .passthrough()
  );

  it('parses a JSON-object string into an object (the create-ediscovery-search repro)', () => {
    const wrapped = coerceJsonStringBody(lazyObjectSchema);
    const raw = JSON.stringify({
      displayName: 'DSAR collection',
      contentQuery: '',
      dataSourceScopes: 'allCaseCustodians',
    });
    const result = wrapped.parse(raw);
    expect(result).toEqual({
      displayName: 'DSAR collection',
      contentQuery: '',
      dataSourceScopes: 'allCaseCustodians',
    });
  });

  it('passes a real object through unchanged (clients that send objects keep working)', () => {
    const wrapped = coerceJsonStringBody(lazyObjectSchema);
    const obj = { displayName: 'kept', contentQuery: 'foo' };
    expect(wrapped.parse(obj)).toEqual(obj);
  });

  it('parses a JSON-array string', () => {
    const wrapped = coerceJsonStringBody(z.array(z.number()));
    expect(wrapped.parse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('leaves a non-JSON / raw-text string untouched (text or binary bodies)', () => {
    const wrapped = coerceJsonStringBody(z.string());
    expect(wrapped.parse('plain text body')).toBe('plain text body');
    // A primitive-looking string is not object/array-shaped → not parsed.
    expect(wrapped.parse('123')).toBe('123');
  });

  it('leaves an unparseable object-looking string for the schema to reject', () => {
    const wrapped = coerceJsonStringBody(z.object({ a: z.string() }));
    // Looks like an object but is malformed JSON → returned as-is → schema fails.
    expect(() => wrapped.parse('{not valid json')).toThrow();
  });

  it('is undefined-safe when made optional (body omitted)', () => {
    const wrapped = coerceJsonStringBody(lazyObjectSchema).optional();
    expect(wrapped.parse(undefined)).toBeUndefined();
  });
});
