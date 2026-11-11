import type { NormalizedRequest, Plan, SentimentLabel } from '../agent/schemas';
import type { Credibility } from '../news/news.types';

export interface SentimentResult {
  score: number;
  label: SentimentLabel;
  positiveTerms: string[];
  negativeTerms: string[];
  /** false when an entity was requested but not mentioned (whole text was scored instead) */
  entityMentioned: boolean;
}

export interface StoryCluster {
  clusterId: string;
  articleIds: string[];
  representativeId: string;
  headline: string;
  outlets: string[];
  firstPublishedAt: string;
  lastPublishedAt: string;
}

/** A fetched article as seen by the analysis step: sanitized, scored and clustered. */
export interface EvidenceArticle {
  id: string;
  title: string;
  outlet: string;
  credibility: Credibility;
  publishedAt: string;
  url: string;
  /** Sanitized text: suspected prompt-injection sentences are replaced by a placeholder. */
  content: string;
  injectionSuspected: boolean;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
  clusterId: string;
}

export interface EvidencePack {
  request: NormalizedRequest;
  plan: Pick<Plan, 'intent' | 'entities' | 'focus'>;
  articles: EvidenceArticle[];
  clusters: StoryCluster[];
}
