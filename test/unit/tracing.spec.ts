import { redact, RunTracer } from '../../src/tracing/run-tracer';

describe('RunTracer', () => {
  it('records ordered events with durations', () => {
    const tracer = new RunTracer('run-1');
    tracer.event('a', { x: 1 });
    tracer.event('b', undefined, 42);
    expect(tracer.getEvents()).toMatchObject([
      { seq: 1, runId: 'run-1', type: 'a', data: { x: 1 } },
      { seq: 2, type: 'b', durationMs: 42 },
    ]);
  });

  it('redacts credentials but keeps token usage counters', () => {
    const out = redact({
      apiKey: 'sk-1',
      authorization: 'Bearer x',
      accessToken: 'y',
      nested: { password: 'p' },
      tokens: 1200,
      promptTokens: 1000,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      apiKey: '[redacted]',
      authorization: '[redacted]',
      accessToken: '[redacted]',
      nested: { password: '[redacted]' },
      tokens: 1200,
      promptTokens: 1000,
    });
  });

  it('truncates long strings and arrays', () => {
    const out = redact({ s: 'x'.repeat(1000), a: Array.from({ length: 30 }, (_, i) => i) }) as { s: string; a: unknown[] };
    expect(out.s.length).toBeLessThan(700);
    expect(out.a).toHaveLength(26);
  });
});
