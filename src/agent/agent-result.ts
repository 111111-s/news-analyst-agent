import type { Correction } from '../guardrails/report-validator';
import type { RefusalCategory } from '../guardrails/input-guard';
import type { Credibility } from '../news/news.types';
import type { NormalizedRequest, Plan, Report } from './schemas';

export type RunStatus = 'completed' | 'partial' | 'insufficient_data' | 'refused' | 'invalid_input' | 'failed';

export interface SourceRef {
  id: string;
  title: string;
  outlet: string;
  url: string;
  publishedAt: string;
  credibility: Credibility;
  clusterId: string | null;
  flags: string[];
}

export interface RunMetrics {
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
  retries: number;
  researchIterations: number;
  repairAttempts: number;
  promptTokens: number;
  completionTokens: number;
  articlesFound: number;
  articlesFetched: number;
}

export interface AgentResult {
  runId: string;
  status: RunStatus;
  createdAt: string;
  promptVersion: string;
  llm: { provider: string; model: string };
  request: NormalizedRequest | null;
  plan: Plan | null;
  report: Report | null;
  sources: SourceRef[];
  guardrails: {
    inputFlags: string[];
    refusal: { category: RefusalCategory; reason: string; source: 'input_guard' | 'planner' | 'model' } | null;
    injectionFindings: Array<{ articleId: string; rules: string[] }>;
    corrections: Correction[];
    validationErrors: string[];
    disclaimers: string[];
    usedFallback: boolean;
  };
  errors: Array<{ code: string; message: string }>;
  metrics: RunMetrics;
  /** Human-readable rendering of this result (Markdown). */
  summaryMarkdown: string;
}

export function emptyMetrics(): RunMetrics {
  return {
    durationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    retries: 0,
    researchIterations: 0,
    repairAttempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    articlesFound: 0,
    articlesFetched: 0,
  };
}
