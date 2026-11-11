import type { Confidence } from '../agent/schemas';
import type { EvidenceArticle } from './analysis.types';

export const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Highest confidence a claim may carry given the articles that support it:
 *  - high:   >= 2 distinct high/medium-credibility outlets
 *  - medium: 1 credible outlet, or >= 2 distinct outlets of unknown credibility
 *  - low:    only low-credibility sources and/or articles flagged for prompt injection
 */
export function maxConfidence(cited: Pick<EvidenceArticle, 'outlet' | 'credibility' | 'injectionSuspected'>[]): Confidence {
  const clean = cited.filter((a) => !a.injectionSuspected);
  const credibleOutlets = new Set(clean.filter((a) => a.credibility === 'high' || a.credibility === 'medium').map((a) => a.outlet));
  if (credibleOutlets.size >= 2) return 'high';
  if (credibleOutlets.size === 1) return 'medium';
  const unknownOutlets = new Set(clean.filter((a) => a.credibility === 'unknown').map((a) => a.outlet));
  return unknownOutlets.size >= 2 ? 'medium' : 'low';
}
