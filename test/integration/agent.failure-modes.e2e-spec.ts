import { NewsAgentService } from '../../src/agent/news-agent.service';
import { RunStore } from '../../src/agent/run-store.service';
import { Report } from '../../src/agent/schemas';
import { ExtractiveReportBuilder } from '../../src/analysis/extractive-report.builder';
import { SentimentService } from '../../src/analysis/sentiment.service';
import { TransientError } from '../../src/common/retry';
import { AppConfig } from '../../src/config/app-config';
import { ChatRequest, LlmConfigurationError, messageText } from '../../src/llm/llm.types';
import { OfflineLlmClient } from '../../src/llm/offline-llm.client';
import { createTestingModule } from '../helpers/agent-factory';
import { ScriptedLlmClient, textResponse, toolCallsResponse } from '../helpers/scripted-llm.client';

const NORTHWIND = { query: 'What is happening with Northwind Robotics?', from: '2026-10-01', to: '2026-11-10', maxArticles: 10 };

async function run(llm: ScriptedLlmClient, request: unknown = NORTHWIND, config: Partial<AppConfig> = {}) {
  const moduleRef = await createTestingModule(config, llm);
  const result = await moduleRef.get(NewsAgentService).run(request);
  const trace = (await moduleRef.get(RunStore).getTrace(result.runId)) ?? [];
  return { result, trace, types: trace.map((e) => e.type) };
}

const offline = new OfflineLlmClient(new ExtractiveReportBuilder(new SentimentService()));

/** A well-formed report for the same evidence, used as a "good" LLM answer that each test then corrupts. */
async function goodReport(req: ChatRequest): Promise<Report> {
  return JSON.parse((await offline.chat(req)).content!) as Report;
}

describe('agent failure modes and guardrails (scripted LLM)', () => {
  it('repairs a planner answer that is not JSON', async () => {
    const llm = new ScriptedLlmClient({ plan: [textResponse('Sure! I will search for Northwind news.')] });
    const { result, types } = await run(llm);
    expect(result.status).toBe('completed');
    expect(result.metrics.repairAttempts).toBe(1);
    expect(types).toEqual(expect.arrayContaining(['validation.failed', 'validation.repaired']));
    const repairPrompt = messageText(llm.stage('plan')[1].messages.at(-1)!);
    expect(repairPrompt).toMatch(/failed validation[\s\S]*not valid JSON/);
  });

  it('falls back to a deterministic plan when the planner keeps failing', async () => {
    const bad = () => textResponse(JSON.stringify({ intent: 'company_brief' }));
    const llm = new ScriptedLlmClient({ plan: [bad(), bad(), bad()] });
    const { result, types } = await run(llm);
    expect(types).toContain('plan.fallback');
    expect(result.plan?.searchQueries).toEqual([NORTHWIND.query]);
    expect(result.guardrails.validationErrors.some((e) => e.startsWith('plan:'))).toBe(true);
    expect(['completed', 'partial']).toContain(result.status);
  });

  it('honours a planner refusal', async () => {
    const refusal = { intent: 'out_of_scope', entities: [], searchQueries: [], focus: [], refuse: true, refusalReason: 'Not news research.' };
    const llm = new ScriptedLlmClient({ plan: [textResponse(JSON.stringify(refusal))] });
    const { result } = await run(llm);
    expect(result.status).toBe('refused');
    expect(result.guardrails.refusal).toMatchObject({ source: 'planner', reason: 'Not news research.' });
    expect(llm.stage('research')).toHaveLength(0);
  });

  it('repairs a report that cites an article that was never fetched', async () => {
    const llm = new ScriptedLlmClient({
      analyze: [
        async (req) => {
          const report = await goodReport(req);
          report.keyDevelopments[0].articleIds.push('nw-999');
          return textResponse(JSON.stringify(report));
        },
      ],
    });
    const { result, types } = await run(llm);
    expect(result.status).toBe('completed');
    expect(types).toContain('validation.repaired');
    expect(messageText(llm.stage('analyze')[1].messages.at(-1)!)).toContain('unknown article id "nw-999"');
    expect(JSON.stringify(result.report)).not.toContain('nw-999');
  });

  it('degrades to a deterministic report when the model keeps hallucinating', async () => {
    const hallucinate = async (req: ChatRequest) => {
      const report = await goodReport(req);
      report.keyDevelopments[0].articleIds = ['made-up-1'];
      report.executiveSummary = 'You should sell all shares now.';
      return textResponse(JSON.stringify(report));
    };
    const llm = new ScriptedLlmClient({ analyze: [hallucinate, hallucinate, hallucinate] });
    const { result, types } = await run(llm);
    expect(result.status).toBe('partial');
    expect(result.guardrails.usedFallback).toBe(true);
    expect(types).toContain('report.fallback');
    const sourceIds = new Set(result.sources.map((s) => s.id));
    expect(result.report!.keyDevelopments.flatMap((d) => d.articleIds).every((id) => sourceIds.has(id))).toBe(true);
    expect(result.report!.executiveSummary).not.toMatch(/you should/i);
  });

  it('corrects over-confident claims and contradicting sentiment in code', async () => {
    const llm = new ScriptedLlmClient({
      analyze: [
        async (req) => {
          const report = await goodReport(req);
          for (const d of report.keyDevelopments) d.confidence = 'high'; // includes the rumour
          report.entitySentiment[0].score = -0.95;
          report.entitySentiment[0].label = 'negative';
          return textResponse(JSON.stringify(report));
        },
      ],
    });
    const { result, types } = await run(llm);
    expect(result.status).toBe('completed');
    expect(types).toContain('validation.corrected');
    const rules = result.guardrails.corrections.map((c) => c.rule);
    expect(rules).toEqual(expect.arrayContaining(['confidence_downgraded', 'sentiment_recomputed']));
    const rumour = result.report!.keyDevelopments.find((d) => d.articleIds.includes('nw-006'))!;
    expect(rumour.confidence).toBe('low');
  });

  it('retries transient LLM errors with backoff and records them', async () => {
    const llm = new ScriptedLlmClient({ research: [new TransientError('429 rate limited'), new TransientError('503')] });
    const { result, types } = await run(llm);
    expect(result.status).toBe('completed');
    expect(result.metrics.retries).toBe(2);
    expect(types.filter((t) => t === 'llm.retry')).toHaveLength(2);
  });

  it('fails cleanly when the LLM stays unavailable before evidence is gathered', async () => {
    const down = () => new TransientError('upstream down');
    const llm = new ScriptedLlmClient({ plan: [down(), down(), down()] });
    const { result, types } = await run(llm);
    expect(result.status).toBe('failed');
    expect(result.errors[0].code).toBe('upstream_unavailable');
    expect(types.at(-1)).toBe('run.end');
  });

  it('keeps the evidence and degrades if the LLM goes down during analysis', async () => {
    const down = () => new TransientError('upstream down');
    const llm = new ScriptedLlmClient({ analyze: [down(), down(), down()] });
    const { result } = await run(llm);
    expect(result.status).toBe('partial');
    expect(result.report?.keyDevelopments.length).toBeGreaterThan(0);
    expect(result.errors.map((e) => e.code)).toContain('upstream_unavailable');
  });

  it('does not retry configuration errors (bad key, no credits)', async () => {
    const llm = new ScriptedLlmClient({ plan: [new LlmConfigurationError('bad key')] });
    const { result } = await run(llm);
    expect(result.status).toBe('failed');
    expect(result.errors[0].code).toBe('llm_configuration');
    expect(result.metrics.llmCalls).toBe(1);
  });

  it('survives a model that calls unknown tools and invented ids, then tops up evidence itself', async () => {
    const llm = new ScriptedLlmClient({
      research: [
        toolCallsResponse([
          { name: 'delete_database', args: {} },
          { name: 'fetch_article', args: { articleId: 'nw-001' } },
        ]),
        textResponse('Done.'),
      ],
    });
    const { result, trace, types } = await run(llm);
    const errors = trace.filter((e) => e.type === 'tool.call' && e.data?.ok === false).map((e) => e.data?.errorCode);
    expect(errors).toEqual(['unknown_tool', 'not_in_search_results']);
    // research never searched, so nothing can be auto-fetched: honest "insufficient data"
    expect(result.status).toBe('insufficient_data');
    expect(types).not.toContain('evidence.autofetch');
  });

  it('auto-fetches evidence when the model under-fetches', async () => {
    const llm = new ScriptedLlmClient({
      research: [toolCallsResponse([{ name: 'search_news', args: { query: 'Northwind Robotics', limit: 10 } }]), textResponse('Enough.')],
    });
    const { result, types } = await run(llm);
    expect(types).toContain('evidence.autofetch');
    expect(result.metrics.articlesFetched).toBe(3);
    expect(result.status).toBe('completed');
  });

  it('stops a model that never stops calling tools (iteration budget)', async () => {
    const loop = () => toolCallsResponse([{ name: 'search_news', args: { query: 'Northwind Robotics', limit: 3 } }]);
    const llm = new ScriptedLlmClient({ research: Array.from({ length: 50 }, loop) });
    const { result, trace } = await run(llm, NORTHWIND, { agentMaxIterations: 4 });
    expect(llm.stage('research')).toHaveLength(4);
    expect(trace.find((e) => e.type === 'research.finished')?.data?.reason).toBe('iteration_budget');
    expect(result.status).toBe('completed');
  });

  it('retries flaky news searches transparently', async () => {
    const { result, types } = await run(new ScriptedLlmClient(), NORTHWIND, { localNewsFailFirstN: 1 });
    expect(result.status).toBe('completed');
    expect(types).toContain('tool.retry');
    expect(result.metrics.retries).toBeGreaterThanOrEqual(1);
  });

  it('treats a model-side refusal during analysis as a degraded result', async () => {
    const llm = new ScriptedLlmClient({ analyze: [textResponse('', { content: null, refusal: 'I cannot help with that.' })] });
    const { result } = await run(llm);
    expect(result.status).toBe('partial');
    expect(result.errors.map((e) => e.code)).toContain('model_refusal');
  });

  it('never puts untrusted article text into system prompts', async () => {
    const llm = new ScriptedLlmClient();
    await run(llm);
    for (const req of llm.requests) {
      const system = messageText(req.messages[0]);
      expect(req.messages[0].role).toBe('system');
      expect(system).not.toMatch(/Northwind|Brightmart|bankrupt/);
    }
  });
});
