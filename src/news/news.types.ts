export type Credibility = 'high' | 'medium' | 'low' | 'unknown';

export interface Article {
  id: string;
  title: string;
  outlet: string;
  url: string;
  /** ISO-8601 timestamp */
  publishedAt: string;
  language: string;
  body: string;
  credibility: Credibility;
}

export interface ArticleSummary {
  id: string;
  title: string;
  outlet: string;
  url: string;
  publishedAt: string;
  credibility: Credibility;
  snippet: string;
  /** Provider relevance score (higher is better); only comparable within one search call. */
  score: number;
}

export interface SearchParams {
  query: string;
  /** YYYY-MM-DD, inclusive */
  from: string;
  /** YYYY-MM-DD, inclusive */
  to: string;
  language: string;
  limit: number;
}

export const NEWS_PROVIDER = Symbol('NEWS_PROVIDER');

/** Port for news backends. Implementations must be read-only and side-effect free. */
export interface NewsProvider {
  readonly name: string;
  search(params: SearchParams): Promise<ArticleSummary[]>;
  getArticle(id: string): Promise<Article | null>;
}
