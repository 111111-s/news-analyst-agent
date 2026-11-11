import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NewsAgentService } from '../../src/agent/news-agent.service';
import { checkExpectations, Expectation } from '../../src/evaluation/expectations';
import { createAgent } from '../helpers/agent-factory';

/**
 * End-to-end: every sample request runs through the real Nest application (orchestrator, tools,
 * local news corpus, guardrails, validators) with the deterministic offline model, and is checked
 * against samples/expected. Same check as `npm run demo`.
 */
const cases = readdirSync(join('samples', 'requests'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    request: JSON.parse(readFileSync(join('samples', 'requests', file), 'utf8')) as unknown,
    expected: JSON.parse(readFileSync(join('samples', 'expected', file), 'utf8')) as Expectation,
  }));

describe('sample scenarios (offline model, full pipeline)', () => {
  let agent: NewsAgentService;

  beforeAll(async () => {
    agent = await createAgent();
  });

  it('has sample cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases)('$file', async ({ request, expected }) => {
    const result = await agent.run(request);
    expect(checkExpectations(result, expected)).toEqual([]);

    // Invariants that hold for every run.
    expect(result.summaryMarkdown).toContain(result.runId);
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    if (['refused', 'invalid_input'].includes(result.status)) {
      expect(result.metrics.llmCalls).toBe(0); // deterministic guards run before any model call
      expect(result.report).toBeNull();
    }
    if (result.report) {
      for (const d of result.report.keyDevelopments) {
        expect(d.date >= result.request!.from && d.date <= result.request!.to).toBe(true);
      }
    }
  });

  it('keeps the poisoned article from influencing the brief', async () => {
    const result = await agent.run(cases.find((c) => c.file.startsWith('01'))!.request);
    const flagged = result.sources.find((s) => s.id === 'nw-009');
    expect(flagged?.flags).toContain('prompt_injection_suspected');
    const devs = result.report!.keyDevelopments.filter((d) => d.articleIds.includes('nw-009'));
    expect(devs.every((d) => d.confidence === 'low')).toBe(true);
    expect(result.summaryMarkdown).not.toMatch(/bankrupt/i);
  });

  it('returns field-level errors for invalid input', async () => {
    const result = await agent.run({ query: '', from: '2026-11-10', to: '2026-10-01', maxArticles: 50, extra: true });
    expect(result.status).toBe('invalid_input');
    const messages = result.errors.map((e) => e.message).join('\n');
    expect(messages).toMatch(/query/);
    expect(messages).toMatch(/maxArticles/);
    expect(messages).toMatch(/extra/);
  });
});
