import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { formatZodIssues } from '../common/json';
import { toStrictJsonSchema } from '../common/json-schema';
import { errorMessage, TransientError, withRetry, withTimeout } from '../common/retry';
import { truncate } from '../common/text';
import type { LlmToolCall, ToolSpec } from '../llm/llm.types';
import type { RunTracer } from '../tracing/run-tracer';
import { NewsTools } from './news-tools';
import { AgentTool, ToolContext, ToolError } from './tool.types';

export interface ToolExecutionResult {
  ok: boolean;
  /** JSON envelope returned to the model: {ok:true,data} | {ok:false,error:{code,message}} */
  content: string;
  errorCode?: string;
}

export interface ToolMetrics {
  retries: number;
}

const TOOL_RETRIES = 2;

/**
 * Single choke point for every tool call: allow-list, budget, JSON + schema validation, timeout,
 * retries for transient upstream errors, and a trace event per call. Tools never throw to the agent;
 * failures become structured errors the model can react to.
 */
@Injectable()
export class ToolExecutor {
  private readonly tools: Map<string, AgentTool<any>>;
  private readonly toolSpecs: ToolSpec[];

  constructor(
    newsTools: NewsTools,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const all = newsTools.all();
    this.tools = new Map(all.map((t) => [t.name, t]));
    this.toolSpecs = all.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: toStrictJsonSchema(t.schema), strict: true },
    }));
  }

  specs(): ToolSpec[] {
    return this.toolSpecs;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(
    call: LlmToolCall,
    ctx: ToolContext,
    tracer: RunTracer,
    metrics: ToolMetrics,
    source: 'model' | 'agent' = 'model',
  ): Promise<ToolExecutionResult> {
    const started = Date.now();
    ctx.state.counters.toolCalls++;
    let attempts = 0;
    let args: unknown;

    const done = (result: ToolExecutionResult, summary: Record<string, unknown>): ToolExecutionResult => {
      if (!result.ok) ctx.state.counters.toolErrors++;
      tracer.event(
        'tool.call',
        { tool: call.name, callId: call.id, source, ok: result.ok, errorCode: result.errorCode, attempts, args, ...summary },
        Date.now() - started,
      );
      return result;
    };
    const fail = (code: string, message: string) =>
      done({ ok: false, errorCode: code, content: JSON.stringify({ ok: false, error: { code, message } }) }, { error: message });

    const tool = this.tools.get(call.name);
    if (!tool) return fail('unknown_tool', `Unknown tool "${truncate(call.name, 64)}". Available tools: ${this.names().join(', ')}.`);
    if (source === 'model' && ctx.state.counters.toolCalls > this.config.agentMaxToolCalls) {
      return fail('tool_budget_exhausted', 'Tool call budget exhausted. Stop calling tools and summarise what you found.');
    }
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return fail('invalid_json', 'Tool arguments are not valid JSON.');
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) return fail('invalid_arguments', formatZodIssues(parsed.error).join('; '));

    try {
      const data = await withRetry(
        async (attempt) => {
          attempts = attempt + 1;
          return withTimeout(tool.execute(parsed.data, ctx), this.config.toolTimeoutMs, `tool ${tool.name}`);
        },
        {
          retries: TOOL_RETRIES,
          baseDelayMs: this.config.retryBaseDelayMs,
          onRetry: (attempt, error, delayMs) => {
            metrics.retries++;
            tracer.event('tool.retry', { tool: tool.name, callId: call.id, attempt, delayMs, error: errorMessage(error) });
          },
        },
      );
      return done({ ok: true, content: JSON.stringify({ ok: true, data }) }, summarize(data));
    } catch (error) {
      if (error instanceof ToolError) return fail(error.code, error.message);
      if (error instanceof TransientError) return fail('upstream_unavailable', `${errorMessage(error)} (after ${attempts} attempts)`);
      return fail('tool_failed', errorMessage(error));
    }
  }
}

/** Compact, non-sensitive description of a tool result for traces. */
function summarize(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.results)) return { resultCount: d.results.length, resultIds: (d.results as Array<{ id: string }>).map((r) => r.id) };
  if (Array.isArray(d.clusters)) return { clusterCount: d.clusters.length };
  if (Array.isArray(d.perArticle)) return { aggregate: d.aggregate };
  if (typeof d.id === 'string') return { articleId: d.id, injectionSuspected: (d.security as { injectionSuspected?: boolean })?.injectionSuspected };
  return {};
}
