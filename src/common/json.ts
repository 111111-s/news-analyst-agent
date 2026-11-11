import { z } from 'zod';

export class JsonExtractionError extends Error {}

/**
 * Parse a JSON object from an LLM completion. Structured outputs normally return clean JSON,
 * but some models wrap it in prose or ``` fences, so we tolerate that and nothing more.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new JsonExtractionError('empty response');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new JsonExtractionError('response is not valid JSON');
  }
}

/** Human/LLM-readable list of zod issues, e.g. `keyDevelopments.0.articleIds: Too small`. */
export function formatZodIssues(error: z.ZodError, limit = 12): string[] {
  return error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
