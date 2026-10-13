import { z } from 'zod';

// Request-body schemas are advertised in tools/list, and nothing else uses them:
// coerceJsonStringBody accepts any value and executeGraphTool forwards the caller's
// payload verbatim, so Graph is the only validator. The generated schemas, though,
// are Graph entities with every navigation property expanded through z.lazy, and
// zod's JSON Schema export inlines them: create-ediscovery-case alone advertised a
// 1 MB input schema, 32 levels deep, and the write catalog reached 9 MB of input
// schema for 643 tools.
//
// Claude.ai serves a connector's tools under a fixed budget of input-schema bytes
// (1 MiB, compact JSON, name and description not counted), admitting tools in
// alphabetical order and dropping what no longer fits. The claude-device bridge
// relays every local server of a Mac under one connector, so they share it. The
// create-*/delete-* bodies, which sort first, used it all up and every get-*/list-*
// read disappeared from cloud sessions.
//
// The advertised body keeps the entity's own fields, with their descriptions, and
// turns every nested object into a free-form one: 595 KB of input schema for the
// whole write catalog, the largest tool 7 KB. Depth 2 measured 1.17 MB, over the
// budget on its own.
export const BODY_SCHEMA_MAX_DEPTH = 1;

// Guards against a z.lazy cycle that never passes through an object, which
// BODY_SCHEMA_MAX_DEPTH alone would not stop. None exists in the generated client.
const MAX_WRAPPER_NESTING = 64;

type Def = {
  type: string;
  innerType?: z.ZodTypeAny;
  getter?: () => z.ZodTypeAny;
  element?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  keyType?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
};

function defOf(schema: z.ZodTypeAny): Def {
  return (schema as unknown as { def: Def }).def;
}

export function shallowBodySchema(
  schema: z.ZodTypeAny,
  maxDepth: number = BODY_SCHEMA_MAX_DEPTH
): z.ZodTypeAny {
  return shallow(schema, 0, maxDepth, 0);
}

function shallow(
  schema: z.ZodTypeAny,
  depth: number,
  maxDepth: number,
  nesting: number
): z.ZodTypeAny {
  if (nesting > MAX_WRAPPER_NESTING) return z.any();
  const def = defOf(schema);
  const next = (s: z.ZodTypeAny, d: number) => shallow(s, d, maxDepth, nesting + 1);

  let result: z.ZodTypeAny;
  switch (def.type) {
    case 'optional':
      result = next(def.innerType!, depth).optional();
      break;
    case 'nullable':
      result = next(def.innerType!, depth).nullable();
      break;
    case 'default':
      result = next(def.innerType!, depth);
      break;
    case 'lazy':
      result = next(def.getter!(), depth);
      break;
    case 'array':
      result = z.array(next(def.element!, depth));
      break;
    case 'union':
      result = z.union(def.options!.map((o) => next(o, depth)) as [z.ZodTypeAny, z.ZodTypeAny]);
      break;
    case 'record':
      result = z.record(
        def.keyType as z.ZodString,
        depth >= maxDepth ? z.any() : next(def.valueType!, depth + 1)
      );
      break;
    case 'object': {
      if (depth >= maxDepth) {
        result = z.looseObject({});
        break;
      }
      const shape = (schema as unknown as z.ZodObject).shape;
      result = z.looseObject(
        Object.fromEntries(
          Object.entries(shape)
            .filter(([, v]) => !isReadOnly(v))
            .map(([k, v]) => [k, next(v, depth + 1)])
        )
      );
      break;
    }
    case 'string':
      // Drops the generator's regex and date-time patterns, two of ~500 bytes on
      // every timestamp field. Graph's description already says ISO 8601.
      result = z.string();
      break;
    default:
      // enum, number, boolean, void, any, unknown…: small, and useful as hints.
      return schema;
  }

  const description = schema.description;
  return description ? result.describe(description) : result;
}

// Graph's metadata ends the description of every server-managed field with
// "Read-only." (id, createdDateTime, createdByUser…). A caller cannot set them, and
// the navigation properties among them are what drag whole entities into a body.
// The field is only dropped from the advertised hints; a payload carrying it is
// still forwarded to Graph untouched.
function isReadOnly(schema: z.ZodTypeAny): boolean {
  let current: z.ZodTypeAny | undefined = schema;
  for (let i = 0; current && i < MAX_WRAPPER_NESTING; i++) {
    if (current.description?.includes('Read-only.')) return true;
    const def = defOf(current);
    if (def.type !== 'optional' && def.type !== 'nullable' && def.type !== 'default') break;
    current = def.innerType;
  }
  return false;
}
