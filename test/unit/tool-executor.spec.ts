import { ClusteringService } from '../../src/analysis/clustering.service';
import { SentimentService } from '../../src/analysis/sentiment.service';
import { InjectionDetector } from '../../src/guardrails/injection-detector';
import { LocalNewsProvider } from '../../src/news/local-news.provider';
import { SourceCredibilityService } from '../../src/news/source-credibility.service';
import { NewsTools } from '../../src/tools/news-tools';
import { ToolExecutor } from '../../src/tools/tool-executor';
import { createResearchState, ToolContext } from '../../src/tools/tool.types';
import { RunTracer } from '../../src/tracing/run-tracer';
import { testConfig } from '../helpers/test-config';

function setup(opts: { failFirstN?: number; maxArticles?: number; maxToolCalls?: number } = {}) {
  const config = testConfig({ agentMaxToolCalls: opts.maxToolCalls ?? 20 });
  const provider = new LocalNewsProvider('data/news-corpus.json', new SourceCredibilityService(config), opts.failFirstN ?? 0);
  const tools = new NewsTools(provider, new InjectionDetector(), new ClusteringService(), new SentimentService());
  const executor = new ToolExecutor(tools, config);
  const ctx: ToolContext = {
    request: { query: 'q', from: '2026-10-01', to: '2026-11-10', language: 'en', maxArticles: opts.maxArticles ?? 5 },
    state: createResearchState(),
  };
  const tracer = new RunTracer('test-run');
  const metrics = { retries: 0 };
  let n = 0;
  const call = (name: string, args: unknown) =>
    executor.execute({ id: `c${++n}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }, ctx, tracer, metrics);
  const parse = (content: string) => JSON.parse(content) as { ok: boolean; data?: any; error?: { code: string; message: string } };
  return { executor, ctx, tracer, metrics, call, parse };
}

describe('ToolExecutor', () => {
  it('exposes four strict function tools', () => {
    const specs = setup().executor.specs();
    expect(specs.map((s) => s.function.name)).toEqual(['search_news', 'fetch_article', 'cluster_stories', 'analyze_sentiment']);
    for (const s of specs) {
      expect(s.function.strict).toBe(true);
      expect((s.function.parameters as any).additionalProperties).toBe(false);
    }
  });

  it.each([
    ['unknown tool', 'delete_database', {}, 'unknown_tool'],
    ['invalid JSON', 'search_news', '{"query": ', 'invalid_json'],
    ['schema violation', 'search_news', { query: 'x', limit: 99 }, 'invalid_arguments'],
    ['fetching an id that search never returned', 'fetch_article', { articleId: 'nw-001' }, 'not_in_search_results'],
    ['analysing articles that were not fetched', 'cluster_stories', { articleIds: ['nw-001'] }, 'not_fetched'],
  ])('returns a structured error for %s', async (_case, name, args, code) => {
    const t = setup();
    const out = await t.call(name, args);
    expect(out.ok).toBe(false);
    expect(t.parse(out.content).error?.code).toBe(code);
    expect(t.ctx.state.counters.toolErrors).toBe(1);
  });

  it('enforces the request date range even if the model passes its own dates', async () => {
    const t = setup();
    const out = await t.call('search_news', { query: 'Northwind Robotics', limit: 10, from: '2020-01-01', to: '2030-01-01' });
    const ids = t.parse(out.content).data.results.map((r: { id: string }) => r.id);
    expect(ids).not.toContain('nw-000');
    expect(t.parse(out.content).data.period).toEqual({ from: '2026-10-01', to: '2026-11-10' });
  });

  it('sanitizes injected instructions on fetch and records the finding', async () => {
    const t = setup();
    await t.call('search_news', { query: 'Northwind Brightmart deal', limit: 10 });
    const out = await t.call('fetch_article', { articleId: 'nw-009' });
    const data = t.parse(out.content).data;
    expect(data.security.injectionSuspected).toBe(true);
    expect(data.untrustedContent).not.toMatch(/ignore all previous instructions/i);
    expect(t.ctx.state.injectionFindings[0].articleId).toBe('nw-009');
  });

  it('enforces the per-run fetch budget', async () => {
    const t = setup({ maxArticles: 1 });
    await t.call('search_news', { query: 'Northwind Robotics', limit: 10 });
    expect((await t.call('fetch_article', { articleId: 'nw-001' })).ok).toBe(true);
    const second = await t.call('fetch_article', { articleId: 'nw-004' });
    expect(t.parse(second.content).error?.code).toBe('fetch_budget_exhausted');
    // re-fetching an already fetched article is free
    expect((await t.call('fetch_article', { articleId: 'nw-001' })).ok).toBe(true);
  });

  it('enforces the tool-call budget', async () => {
    const t = setup({ maxToolCalls: 1 });
    expect((await t.call('search_news', { query: 'Helios', limit: null })).ok).toBe(true);
    const out = await t.call('search_news', { query: 'Solaris', limit: null });
    expect(t.parse(out.content).error?.code).toBe('tool_budget_exhausted');
  });

  it('retries transient upstream failures and traces each retry', async () => {
    const t = setup({ failFirstN: 1 });
    const out = await t.call('search_news', { query: 'Helios Energy', limit: 5 });
    expect(out.ok).toBe(true);
    expect(t.metrics.retries).toBe(1);
    const types = t.tracer.getEvents().map((e) => e.type);
    expect(types).toEqual(['tool.retry', 'tool.call']);
    expect(t.tracer.getEvents()[1].data).toMatchObject({ ok: true, attempts: 2 });
  });

  it('clusters and scores fetched articles', async () => {
    const t = setup();
    await t.call('search_news', { query: 'Helios Energy', limit: 10 });
    for (const id of ['he-001', 'he-002', 'he-003']) await t.call('fetch_article', { articleId: id });
    const clusters = t.parse((await t.call('cluster_stories', { articleIds: ['he-001', 'he-002', 'he-003'] })).content).data.clusters;
    expect(clusters.map((c: { articleIds: string[] }) => c.articleIds)).toEqual([['he-001', 'he-002'], ['he-003']]);
    const sentiment = t.parse((await t.call('analyze_sentiment', { articleIds: ['he-003'], entity: 'Helios Energy' })).content).data;
    expect(sentiment.perArticle[0].label).toBe('negative');
  });
});
