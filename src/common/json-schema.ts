import { z } from 'zod';

type Json = Record<string, unknown>;

/**
 * Keywords that OpenAI strict structured outputs may reject. Constraints are still enforced on our
 * side by zod after parsing - the JSON schema sent to the model is a shape hint, zod is the source of truth.
 */
const STRIPPED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'default',
]);

/** Convert a zod schema to a JSON schema compatible with OpenAI `strict: true` (tools and response_format). */
export function toStrictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any', io: 'input' }) as Json;
  return strictify(raw) as Json;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    out[key === 'oneOf' ? 'anyOf' : key] = strictify(value);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.required = Object.keys(out.properties as Json);
    out.additionalProperties = false;
  }
  return out;
}
