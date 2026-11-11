import { z } from 'zod';
import { extractJson, JsonExtractionError } from '../../src/common/json';
import { toStrictJsonSchema } from '../../src/common/json-schema';
import { TransientError, withRetry } from '../../src/common/retry';
import { splitSentences, stem, tokenize } from '../../src/common/text';

describe('text helpers', () => {
  it('tokenizes, removes stopwords and stems', () => {
    expect(tokenize('The companies recalls launches of Robotics!')).toEqual(['company', 'recall', 'launch', 'robotic']);
    expect(stem('business')).toBe('business');
  });

  it('splits sentences without breaking on decimals', () => {
    expect(splitSentences('It exposed 1.2 million accounts. No payment data was accessed.')).toEqual([
      'It exposed 1.2 million accounts.',
      'No payment data was accessed.',
    ]);
  });
});

describe('extractJson', () => {
  it('parses plain, fenced and prose-wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} hope it helps')).toEqual({ a: 3 });
  });

  it('throws on empty or non-JSON output', () => {
    expect(() => extractJson('')).toThrow(JsonExtractionError);
    expect(() => extractJson('I cannot do that')).toThrow(JsonExtractionError);
  });
});

describe('toStrictJsonSchema', () => {
  it('produces an OpenAI strict-mode compatible schema', () => {
    const schema = toStrictJsonSchema(
      z.object({ name: z.string().min(3).max(10), tags: z.array(z.string()).max(2), note: z.string().nullable() }),
    ) as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['name', 'tags', 'note']);
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.name.minLength).toBeUndefined();
    expect(schema.properties.tags.maxItems).toBeUndefined();
  });
});

describe('withRetry', () => {
  const noSleep = async () => undefined;

  it('retries transient errors and then succeeds', async () => {
    const onRetry = jest.fn();
    let calls = 0;
    const value = await withRetry(
      async () => {
        if (++calls < 3) throw new TransientError('flaky');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1, sleep: noSleep, onRetry },
    );
    expect(value).toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient errors', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('bad request'));
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1, sleep: noSleep })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget', async () => {
    const fn = jest.fn().mockRejectedValue(new TransientError('down'));
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1, sleep: noSleep })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
