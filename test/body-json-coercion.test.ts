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

  it('never hard-rejects a body the generated schema does not match (Graph validates)', () => {
    // A nested Graph flagged-enum field (e.g. export-review-set exportOptions)
    // is generated as an object but Graph expects a comma-separated string.
    // Strict validation used to throw "expected object, received string"; now the
    // payload passes through untouched so it can reach Graph.
    const exportLike = z.object({
      outputName: z.string().nullish(),
      exportOptions: z.object({}).passthrough(), // mis-generated: should be a string enum
      exportStructure: z.object({}).passthrough(),
    });
    const wrapped = coerceJsonStringBody(exportLike);
    const body = {
      outputName: 'DSAR-export',
      exportOptions: 'originalFiles,fileInfo',
      exportStructure: 'directory',
    };
    expect(wrapped.parse(body)).toEqual(body);
  });

  it('passes an unparseable object-looking string through (no hard reject)', () => {
    const wrapped = coerceJsonStringBody(z.object({ a: z.string() }));
    // Malformed JSON → returned as-is; accepted by the permissive fallback rather
    // than throwing locally.
    expect(wrapped.parse('{not valid json')).toBe('{not valid json');
  });

  it('is undefined-safe when made optional (body omitted)', () => {
    const wrapped = coerceJsonStringBody(lazyObjectSchema).optional();
    expect(wrapped.parse(undefined)).toBeUndefined();
  });
});
