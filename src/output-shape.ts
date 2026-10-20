/**
 * Opt-in compaction of list responses, selected per call with `shape`.
 *
 * A 216-row managedDevices list cost a device audit most of its context:
 * every row repeats every field name, a third of the fields are null, and the
 * JSON is indented. `$select` already chooses the columns; `shape` shrinks what
 * is left:
 *   - `compact` drops null, empty-string, empty-array and empty-object fields,
 *     recursively. Graph uses null for "no value", so nothing is lost.
 *   - `table` compacts, then turns the list into `{ columns, rows }`: the field
 *     names appear once and each row is an array in column order, with null
 *     where a row lacks a column.
 * Both emit unindented JSON.
 *
 * Pure module: graph-tools.ts applies it to the response text before the
 * untrusted-content envelope.
 */

export const OUTPUT_SHAPES = ['compact', 'table'] as const;
export type OutputShape = (typeof OUTPUT_SHAPES)[number];

export function isOutputShape(x: unknown): x is OutputShape {
  return typeof x === 'string' && (OUTPUT_SHAPES as readonly string[]).includes(x);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `undefined` means "drop this value". */
export function compactValue(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    // Array elements keep their position: a null inside an array is data.
    return value.length === 0 ? undefined : value.map((v) => compactValue(v) ?? null);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compactValue(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}

/**
 * `{ ...rest, [listKey]: [{…}, …] }` → `{ ...rest, columns, rows }`. Columns are
 * in order of first appearance. A list that is missing or holds anything but
 * objects is left as it is.
 */
export function toTable(
  payload: Record<string, unknown>,
  listKey: string
): Record<string, unknown> {
  const list = payload[listKey];
  if (!Array.isArray(list) || !list.every(isPlainObject)) return payload;

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const rows = list.map((row) => columns.map((c) => (c in row ? row[c] : null)));

  const rest = { ...payload };
  delete rest[listKey];
  return { ...rest, columns, rows };
}

/**
 * Reshapes a JSON response text. A text that is not a JSON object (an error
 * string, a CSV report, a bare value) comes back unchanged.
 */
export function shapeResponseText(text: string, shape: OutputShape, listKey = 'value'): string {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isPlainObject(payload)) return text;

  const compacted = (compactValue(payload) as Record<string, unknown> | undefined) ?? {};
  // An empty list is the answer, not an empty field: keep it.
  if (Array.isArray(payload[listKey]) && !(listKey in compacted)) compacted[listKey] = [];
  const shaped = shape === 'table' ? toTable(compacted, listKey) : compacted;
  return JSON.stringify(shaped);
}
