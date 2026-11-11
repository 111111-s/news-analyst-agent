import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EvidenceArticle, EvidencePack } from '../analysis/analysis.types';
import { ClusteringService } from '../analysis/clustering.service';
import { ExtractiveReportBuilder } from '../analysis/extractive-report.builder';
import { SentimentService } from '../analysis/sentiment.service';
import { extractJson, formatZodIssues } from '../common/json';
import { toStrictJsonSchema } from '../common/json-schema';
import { errorMessage, TransientError, withRetry } from '../common/retry';
import { isoDay, truncate, unique } from '../common/text';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { CLOCK, Clock } from '../config/config.module';
import { InputGuard } from '../guardrails/input-guard';
import { Correction, ReportValidator } from '../guardrails/report-validator';
import {
  assistantMessage,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLM_CLIENT,
  LlmClient,
  LlmConfigurationError,
  LlmStage,
  messageText,
} from '../llm/llm.types';
import { createResearchState, ResearchState } from '../tools/tool.types';
import { ToolExecutor } from '../tools/tool-executor';
import { RunTracer } from '../tracing/run-tracer';
import { TraceService } from '../tracing/trace.service';
import { AgentResult, emptyMetrics, RunMetrics } from './agent-result';
import {
  ANALYST_SYSTEM,
  analystUser,
  INVESTMENT_DISCLAIMER,
  PLANNER_SYSTEM,
  plannerUser,
  PROMPT_VERSION,
  repairUser,
  RESEARCH_SYSTEM,
  researchUser,
} from './prompts';
import { renderMarkdown } from './report-renderer';
import { RunStore } from './run-store.service';
import { AnalyzeRequestSchema, NormalizedRequest, Plan, PlanSchema, Report, ReportSchema } from './schemas';

interface RunContext {
  tracer: RunTracer;
  startedAt: number;
  metrics: RunMetrics;
  result: AgentResult;
}

type Accepted<T> = { ok: true; value: T } | { ok: false; errors: string[] };

interface StructuredOutcome<T> {
  value: T | null;
  errors: string[];
  refusal: string | null;
}

const PLAN_JSON_SCHEMA = toStrictJsonSchema(PlanSchema);
const REPORT_JSON_SCHEMA = toStrictJsonSchema(ReportSchema);
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Orchestrates one analysis run as an explicit state machine:
 *
 *   validate -> input guard -> PLAN (LLM, structured) -> RESEARCH (LLM tool loop, bounded)
 *     -> build evidence (deterministic) -> ANALYZE (LLM, structured) -> validate/repair -> finish
 *
 * The LLM decides *what* to search, fetch and write; code decides what is *allowed* (scope, budgets,
 * citations, confidence) and always produces a valid result, degrading to deterministic output when needed.
 */
@Injectable()
export class NewsAgentService {
  private readonly logger = new Logger(NewsAgentService.name);

  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tools: ToolExecutor,
    private readonly inputGuard: InputGuard,
    private readonly validator: ReportValidator,
    private readonly clustering: ClusteringService,
    private readonly sentiment: SentimentService,
    private readonly reportBuilder: ExtractiveReportBuilder,
    private readonly traces: TraceService,
    private readonly runs: RunStore,
  ) {}

  async run(input: unknown): Promise<AgentResult> {
    const runId = randomUUID();
    const ctx: RunContext = {
      tracer: this.traces.start(runId),
      startedAt: Date.now(),
      metrics: emptyMetrics(),
      result: this.blankResult(runId),
    };
    ctx.tracer.event('run.start', { provider: this.llm.provider, model: this.llm.model, promptVersion: PROMPT_VERSION });
    try {
      await this.execute(input, ctx);
    } catch (error) {
      const code =
        error instanceof LlmConfigurationError ? 'llm_configuration' : error instanceof TransientError ? 'upstream_unavailable' : 'internal_error';
      ctx.result.status = 'failed';
      ctx.result.errors.push({ code, message: errorMessage(error) });
      ctx.tracer.event('run.error', { code, message: errorMessage(error) });
      this.logger.error(`run ${runId} failed: ${errorMessage(error)}`);
    }
    return this.finish(ctx);
  }

  // ------------------------------------------------------------------------------------------
  private async execute(input: unknown, ctx: RunContext): Promise<void> {
    const r = ctx.result;

    // 1. Validate input (deterministic).
    const parsed = AnalyzeRequestSchema.safeParse(input);
    if (!parsed.success) {
      r.status = 'invalid_input';
      r.errors = formatZodIssues(parsed.error).map((message) => ({ code: 'invalid_input', message }));
      ctx.tracer.event('input.invalid', { errors: r.errors.map((e) => e.message) });
      return;
    }
    const request = this.normalize(parsed.data);
    r.request = request;

    // 2. Input guard (deterministic, before any model call).
    const guard = this.inputGuard.check(request.query);
    r.guardrails.inputFlags = guard.flags;
    ctx.tracer.event('guard.input', { action: guard.action, category: guard.category, flags: guard.flags });
    if (guard.action === 'refuse') {
      r.status = 'refused';
      r.guardrails.refusal = { category: guard.category!, reason: guard.reason!, source: 'input_guard' };
      return;
    }
    if (guard.flags.includes('investment_advice_request')) r.guardrails.disclaimers.push(INVESTMENT_DISCLAIMER);

    // 3. Plan (LLM, structured output, validated + repaired).
    const plan = await this.plan(request, ctx);
    r.plan = plan;
    if (plan.refuse || plan.intent === 'out_of_scope') {
      r.status = 'refused';
      r.guardrails.refusal = {
        category: 'out_of_scope',
        reason: plan.refusalReason ?? 'The request is not a news research task.',
        source: 'planner',
      };
      return;
    }

    // 4. Research (LLM tool loop with hard budgets).
    const state = await this.research(request, plan, ctx);

    // 5. Evidence (deterministic: completion, sanitization, clustering, sentiment).
    const pack = await this.buildEvidence(request, plan, state, ctx);
    r.sources = pack.articles.map((a) => ({
      id: a.id,
      title: a.title,
      outlet: a.outlet,
      url: a.url,
      publishedAt: a.publishedAt,
      credibility: a.credibility,
      clusterId: a.clusterId,
      flags: [...(a.injectionSuspected ? ['prompt_injection_suspected'] : []), ...(a.credibility === 'low' ? ['low_credibility'] : [])],
    }));
    r.guardrails.injectionFindings = state.injectionFindings;
    ctx.metrics.articlesFound = state.searchResults.size;
    ctx.metrics.articlesFetched = pack.articles.length;

    if (pack.articles.length === 0) {
      r.status = 'insufficient_data';
      r.report = this.reportBuilder.buildEmpty(request, plan.entities);
      ctx.tracer.event('report.empty', { reason: 'no relevant articles in period' });
      return;
    }

    // 6. Analyze (LLM, structured) -> validate -> repair -> deterministic fallback.
    await this.analyze(pack, guard.flags, ctx);
  }

  private normalize(data: { query: string; from?: string; to?: string; language: string; maxArticles: number }): NormalizedRequest {
    const today = isoDay(this.clock.now());
    const to = data.to ?? (data.from && data.from > today ? data.from : today);
    const from = data.from ?? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - DEFAULT_WINDOW_DAYS * 86_400_000));
    return { query: data.query, from, to, language: data.language, maxArticles: data.maxArticles };
  }

  // ------------------------------------------------------------------------------------------
  private async plan(request: NormalizedRequest, ctx: RunContext): Promise<Plan> {
    const outcome = await this.structuredCall<Plan>(
      {
        stage: 'plan',
        system: PLANNER_SYSTEM,
        user: plannerUser(request),
        schemaName: 'research_plan',
        jsonSchema: PLAN_JSON_SCHEMA,
        accept: (raw) => {
          const p = PlanSchema.safeParse(raw);
          if (!p.success) return { ok: false, errors: formatZodIssues(p.error) };
          if (!p.data.refuse && p.data.searchQueries.length === 0) {
            return { ok: false, errors: ['searchQueries: provide at least one query unless refuse=true'] };
          }
          return { ok: true, value: p.data };
        },
      },
      ctx,
    );

    if (outcome.refusal) {
      return { intent: 'out_of_scope', entities: [], searchQueries: [], focus: [], refuse: true, refusalReason: truncate(outcome.refusal, 300) };
    }
    let plan = outcome.value;
    if (!plan) {
      // Degrade gracefully: search for the raw query rather than failing the run.
      ctx.result.guardrails.validationErrors.push(...outcome.errors.map((e) => `plan: ${e}`));
      plan = { intent: 'topic_overview', entities: [], searchQueries: [truncate(request.query, 120)], focus: [], refuse: false, refusalReason: null };
      ctx.tracer.event('plan.fallback', { errors: outcome.errors });
    }
    plan = { ...plan, searchQueries: unique(plan.searchQueries.map((q) => q.trim()).filter(Boolean)).slice(0, 5) };
    ctx.tracer.event('plan.ready', { intent: plan.intent, entities: plan.entities, searchQueries: plan.searchQueries, refuse: plan.refuse });
    return plan;
  }

  // ------------------------------------------------------------------------------------------
  private async research(request: NormalizedRequest, plan: Plan, ctx: RunContext): Promise<ResearchState> {
    const state = createResearchState();
    const toolCtx = { request, state };
    const messages: ChatMessage[] = [
      { role: 'system', content: RESEARCH_SYSTEM },
      { role: 'user', content: researchUser(request, plan) },
    ];
    let reason = 'iteration_budget';

    for (let i = 0; i < this.config.agentMaxIterations; i++) {
      ctx.metrics.researchIterations++;
      const res = await this.callLlm({ stage: 'research', repairAttempt: 0, messages, tools: this.tools.specs() }, ctx);
      if (res.refusal) {
        reason = 'model_refusal';
        break;
      }
      if (res.toolCalls.length === 0) {
        reason = 'model_finished';
        ctx.tracer.event('research.note', { note: truncate(res.content ?? '', 300) });
        break;
      }
      messages.push(assistantMessage(res));
      // Sequential on purpose: keeps traces ordered and budget checks race-free.
      for (const call of res.toolCalls) {
        const out = await this.tools.execute(call, toolCtx, ctx.tracer, ctx.metrics);
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.content });
      }
      if (state.counters.toolCalls >= this.config.agentMaxToolCalls) {
        reason = 'tool_budget';
        break;
      }
    }
    ctx.metrics.toolCalls = state.counters.toolCalls;
    ctx.metrics.toolErrors = state.counters.toolErrors;
    ctx.tracer.event('research.finished', {
      reason,
      iterations: ctx.metrics.researchIterations,
      searches: state.counters.searches,
      found: state.searchResults.size,
      fetched: state.fetched.size,
    });
    return state;
  }

  private async buildEvidence(request: NormalizedRequest, plan: Plan, state: ResearchState, ctx: RunContext): Promise<EvidencePack> {
    // Deterministic completion: if the model under-fetched, top up from search results so the
    // analysis never runs on an artificially thin evidence base.
    const minimum = Math.min(request.maxArticles, 3);
    if (state.fetched.size < minimum) {
      const before = state.fetched.size;
      for (const candidate of state.searchResults.keys()) {
        if (state.fetched.size >= minimum) break;
        if (state.fetched.has(candidate)) continue;
        await this.tools.execute(
          { id: `agent-autofetch-${candidate}`, name: 'fetch_article', arguments: JSON.stringify({ articleId: candidate }) },
          { request, state },
          ctx.tracer,
          ctx.metrics,
          'agent',
        );
      }
      if (state.fetched.size > before) ctx.tracer.event('evidence.autofetch', { added: state.fetched.size - before });
      ctx.metrics.toolCalls = state.counters.toolCalls;
      ctx.metrics.toolErrors = state.counters.toolErrors;
    }

    const fetched = [...state.fetched.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    const clusters = this.clustering.cluster(fetched);
    const clusterOf = new Map(clusters.flatMap((c) => c.articleIds.map((id) => [id, c.clusterId] as const)));
    const articles: EvidenceArticle[] = fetched.map((a) => {
      const s = this.sentiment.scoreArticle(a);
      return {
        id: a.id,
        title: a.title,
        outlet: a.outlet,
        credibility: a.credibility,
        publishedAt: a.publishedAt,
        url: a.url,
        content: a.content,
        injectionSuspected: a.injectionSuspected,
        sentimentScore: s.score,
        sentimentLabel: s.label,
        clusterId: clusterOf.get(a.id) ?? 'story-?',
      };
    });
    ctx.tracer.event('evidence.ready', {
      articles: articles.length,
      clusters: clusters.length,
      injectionSuspected: articles.filter((a) => a.injectionSuspected).map((a) => a.id),
    });
    return { request, plan: { intent: plan.intent, entities: plan.entities, focus: plan.focus }, articles, clusters };
  }

  // ------------------------------------------------------------------------------------------
  private async analyze(pack: EvidencePack, inputFlags: string[], ctx: RunContext): Promise<void> {
    const r = ctx.result;
    let outcome: StructuredOutcome<{ report: Report; corrections: Correction[] }>;
    try {
      outcome = await this.structuredCall(
        {
          stage: 'analyze',
          system: ANALYST_SYSTEM,
          user: analystUser(pack, inputFlags),
          schemaName: 'news_report',
          jsonSchema: REPORT_JSON_SCHEMA,
          accept: (raw) => {
            const v = this.validator.validate(raw, pack);
            return v.ok && v.report ? { ok: true, value: { report: v.report, corrections: v.corrections } } : { ok: false, errors: v.errors };
          },
        },
        ctx,
      );
    } catch (error) {
      if (!(error instanceof TransientError)) throw error;
      // Evidence is already paid for: keep it and degrade instead of failing the whole run.
      outcome = { value: null, errors: [`LLM unavailable: ${errorMessage(error)}`], refusal: null };
      r.errors.push({ code: 'upstream_unavailable', message: errorMessage(error) });
    }

    if (outcome.value) {
      r.status = 'completed';
      r.report = outcome.value.report;
      r.guardrails.corrections = outcome.value.corrections;
      if (outcome.value.corrections.length) {
        ctx.tracer.event('validation.corrected', { corrections: outcome.value.corrections.map((c) => `${c.path}:${c.rule}`) });
      }
      return;
    }
    r.status = 'partial';
    r.report = this.reportBuilder.build(pack);
    r.guardrails.usedFallback = true;
    r.guardrails.validationErrors.push(...outcome.errors);
    if (outcome.refusal) r.errors.push({ code: 'model_refusal', message: truncate(outcome.refusal, 300) });
    ctx.tracer.event('report.fallback', { reason: outcome.refusal ? 'model_refusal' : 'validation_failed', errors: outcome.errors });
  }

  // ------------------------------------------------------------------------------------------
  /** Structured LLM call with a validate -> feed errors back -> retry ("repair") loop. */
  private async structuredCall<T>(
    opts: {
      stage: LlmStage;
      system: string;
      user: string;
      schemaName: string;
      jsonSchema: Record<string, unknown>;
      accept: (raw: unknown) => Accepted<T>;
    },
    ctx: RunContext,
  ): Promise<StructuredOutcome<T>> {
    const messages: ChatMessage[] = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ];
    let errors: string[] = [];
    for (let attempt = 0; attempt <= this.config.agentMaxRepairs; attempt++) {
      if (attempt > 0) ctx.metrics.repairAttempts++;
      const res = await this.callLlm(
        { stage: opts.stage, repairAttempt: attempt, messages, responseFormat: { name: opts.schemaName, schema: opts.jsonSchema } },
        ctx,
      );
      if (res.refusal) {
        ctx.tracer.event('llm.refusal', { stage: opts.stage, refusal: truncate(res.refusal, 300) });
        return { value: null, errors: [], refusal: res.refusal };
      }
      let raw: unknown;
      let parsedJson = false;
      try {
        raw = extractJson(res.content ?? '');
        parsedJson = true;
      } catch (error) {
        errors = [`response is not valid JSON (${errorMessage(error)})${res.finishReason === 'length' ? '; output was truncated' : ''}`];
      }
      if (parsedJson) {
        const accepted = opts.accept(raw);
        if (accepted.ok) {
          if (attempt > 0) ctx.tracer.event('validation.repaired', { stage: opts.stage, attempt });
          return { value: accepted.value, errors: [], refusal: null };
        }
        errors = accepted.errors;
      }
      ctx.tracer.event('validation.failed', { stage: opts.stage, attempt, errors });
      messages.push({ role: 'assistant', content: res.content ?? '' }, { role: 'user', content: repairUser(errors) });
    }
    return { value: null, errors, refusal: null };
  }

  /** Every model call goes through here: retries with backoff for transient errors + tracing. */
  private async callLlm(request: ChatRequest, ctx: RunContext): Promise<ChatResponse> {
    return withRetry(
      async (attempt) => {
        const started = Date.now();
        ctx.metrics.llmCalls++;
        try {
          const res = await this.llm.chat(request);
          ctx.metrics.promptTokens += res.usage.promptTokens;
          ctx.metrics.completionTokens += res.usage.completionTokens;
          ctx.tracer.event(
            'llm.call',
            {
              stage: request.stage,
              repairAttempt: request.repairAttempt,
              attempt,
              model: res.model,
              finishReason: res.finishReason,
              toolCalls: res.toolCalls.map((t) => t.name),
              promptTokens: res.usage.promptTokens,
              completionTokens: res.usage.completionTokens,
              ...(this.config.traceLlmPayloads
                ? { lastMessage: truncate(messageText(request.messages[request.messages.length - 1]), 2000), output: res.content }
                : {}),
            },
            Date.now() - started,
          );
          return res;
        } catch (error) {
          ctx.tracer.event(
            'llm.error',
            { stage: request.stage, attempt, error: errorMessage(error), retryable: error instanceof TransientError },
            Date.now() - started,
          );
          throw error;
        }
      },
      {
        retries: this.config.llmMaxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        onRetry: (attempt, error, delayMs) => {
          ctx.metrics.retries++;
          ctx.tracer.event('llm.retry', { stage: request.stage, attempt, delayMs, error: errorMessage(error) });
        },
      },
    );
  }

  // ------------------------------------------------------------------------------------------
  private async finish(ctx: RunContext): Promise<AgentResult> {
    const r = ctx.result;
    r.metrics = { ...ctx.metrics, durationMs: Date.now() - ctx.startedAt };
    r.summaryMarkdown = renderMarkdown(r);
    ctx.tracer.event('run.end', {
      status: r.status,
      durationMs: r.metrics.durationMs,
      llmCalls: r.metrics.llmCalls,
      toolCalls: r.metrics.toolCalls,
      retries: r.metrics.retries,
      tokens: r.metrics.promptTokens + r.metrics.completionTokens,
    });
    await this.runs.save(r, ctx.tracer.getEvents());
    return r;
  }

  private blankResult(runId: string): AgentResult {
    return {
      runId,
      status: 'failed',
      createdAt: new Date().toISOString(),
      promptVersion: PROMPT_VERSION,
      llm: { provider: this.llm.provider, model: this.llm.model },
      request: null,
      plan: null,
      report: null,
      sources: [],
      guardrails: {
        inputFlags: [],
        refusal: null,
        injectionFindings: [],
        corrections: [],
        validationErrors: [],
        disclaimers: [],
        usedFallback: false,
      },
      errors: [],
      metrics: emptyMetrics(),
      summaryMarkdown: '',
    };
  }
}
