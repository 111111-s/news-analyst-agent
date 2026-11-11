import type { z } from 'zod';
import type { NormalizedRequest } from '../agent/schemas';
import type { Article, ArticleSummary } from '../news/news.types';

export interface FetchedArticle extends Article {
  /** Sanitized, truncated body that is shown to the model. */
  content: string;
  injectionSuspected: boolean;
  injectionRules: string[];
}

/** Mutable per-run state shared by the tools. Never shared between runs. */
export interface ResearchState {
  /** id -> summary, insertion order = order in which the agent first saw the article */
  searchResults: Map<string, ArticleSummary>;
  fetched: Map<string, FetchedArticle>;
  injectionFindings: Array<{ articleId: string; rules: string[] }>;
  counters: { toolCalls: number; toolErrors: number; searches: number };
}

export function createResearchState(): ResearchState {
  return {
    searchResults: new Map(),
    fetched: new Map(),
    injectionFindings: [],
    counters: { toolCalls: 0, toolErrors: 0, searches: 0 },
  };
}

export interface ToolContext {
  request: NormalizedRequest;
  state: ResearchState;
}

export interface AgentTool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<TInput>;
  execute(input: TInput, ctx: ToolContext): Promise<unknown>;
}

/** Expected, non-retryable tool failure that is reported back to the model as a structured error. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
