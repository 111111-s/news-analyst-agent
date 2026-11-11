import { Injectable } from '@nestjs/common';
import type { SentimentLabel } from '../agent/schemas';
import { splitSentences, tokenize } from '../common/text';
import { SentimentResult } from './analysis.types';

const POSITIVE = `raise raised raising secure secured win won record growth grow grew strong strongly expand expanded
  expansion partnership partner launch launched unveil unveiled job create creating beat surge surged deal agreement
  breakthrough momentum recover recovery clear welcomed welcome investment leader ahead improve improved boost approval
  award profit profitable gain gains rally upgrade`;

const NEGATIVE = `recall recalling defect defective overheating overheat lawsuit damage allege alleged degrade breach hack
  hacker unauthorized exposed expose inquiry investigation fine miss missed missing weak weaker fall falling fell slide
  slid strike delay delayed backlog shutdown warn warned pause paused cut lower loss layoff bankrupt bankruptcy risk
  threaten threat pressure decline concern vulnerability diverting downgrade penalty fraud scandal plunge plunged`;

const toSet = (words: string) => new Set(tokenize(words));
const POSITIVE_TERMS = toSet(POSITIVE);
const NEGATIVE_TERMS = toSet(NEGATIVE);

export const SENTIMENT_THRESHOLD = 0.15;

export function labelForScore(score: number, hasPositive = false, hasNegative = false): SentimentLabel {
  if (score > SENTIMENT_THRESHOLD) return 'positive';
  if (score < -SENTIMENT_THRESHOLD) return 'negative';
  return hasPositive && hasNegative ? 'mixed' : 'neutral';
}

/** First token of an entity name that is distinctive enough to detect mentions ("Helios Energy" -> "helios"). */
export function entityMentioned(text: string, entity: string): boolean {
  const haystack = text.toLowerCase();
  const name = entity.trim().toLowerCase();
  if (!name) return false;
  if (haystack.includes(name)) return true;
  const first = name.split(/\s+/)[0];
  return first.length >= 4 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(haystack);
}

/**
 * Deterministic lexicon-based sentiment. Not state of the art - its job is to give the agent a
 * reproducible, explainable signal that the LLM's sentiment claims are checked against.
 */
@Injectable()
export class SentimentService {
  score(text: string, entity?: string | null): SentimentResult {
    let scope = text;
    let mentioned = true;
    if (entity) {
      const sentences = splitSentences(text).filter((s) => entityMentioned(s, entity));
      mentioned = sentences.length > 0;
      if (mentioned) scope = sentences.join(' ');
    }
    const positiveTerms: string[] = [];
    const negativeTerms: string[] = [];
    for (const token of tokenize(scope)) {
      if (POSITIVE_TERMS.has(token)) positiveTerms.push(token);
      else if (NEGATIVE_TERMS.has(token)) negativeTerms.push(token);
    }
    const p = positiveTerms.length;
    const n = negativeTerms.length;
    const score = Math.round(((p - n) / (p + n + 1)) * 1000) / 1000;
    return {
      score,
      label: labelForScore(score, p > 0, n > 0),
      positiveTerms: [...new Set(positiveTerms)],
      negativeTerms: [...new Set(negativeTerms)],
      entityMentioned: mentioned,
    };
  }

  scoreArticle(article: { title: string; content: string }, entity?: string | null): SentimentResult {
    return this.score(`${article.title}. ${article.content}`, entity);
  }

  /** Mean over several article scores, with a "mixed" label when strong signals point both ways. */
  aggregate(scores: number[]): { score: number; label: SentimentLabel } {
    if (scores.length === 0) return { score: 0, label: 'neutral' };
    const mean = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000;
    const hasPos = scores.some((s) => s > SENTIMENT_THRESHOLD);
    const hasNeg = scores.some((s) => s < -SENTIMENT_THRESHOLD);
    return { score: mean, label: labelForScore(mean, hasPos, hasNeg) };
  }
}
