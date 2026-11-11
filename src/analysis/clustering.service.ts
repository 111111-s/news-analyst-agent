import { Injectable } from '@nestjs/common';
import { daysBetween, splitSentences, tokenize } from '../common/text';
import type { Credibility } from '../news/news.types';
import { StoryCluster } from './analysis.types';

export interface ClusterableArticle {
  id: string;
  title: string;
  content: string;
  outlet: string;
  publishedAt: string;
  credibility: Credibility;
  injectionSuspected?: boolean;
}

const CREDIBILITY_RANK: Record<Credibility, number> = { high: 3, medium: 2, unknown: 1, low: 0 };

/**
 * Groups articles that report the same story (syndicated / rewritten coverage) using TF-IDF cosine
 * similarity over headline + lead sentence, restricted to a time window. Deterministic.
 */
export interface ClusterOptions {
  similarityThreshold: number;
  maxDaysApart: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = { similarityThreshold: 0.22, maxDaysApart: 4 };

@Injectable()
export class ClusteringService {
  cluster(articles: ClusterableArticle[], options: ClusterOptions = DEFAULT_CLUSTER_OPTIONS): StoryCluster[] {
    if (articles.length === 0) return [];
    const vectors = this.vectorize(articles);
    const parent = articles.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));

    for (let i = 0; i < articles.length; i++) {
      for (let j = i + 1; j < articles.length; j++) {
        // Unverified sources never merge into credible stories: a rumour must stay visible as its own,
        // low-confidence item instead of borrowing confidence from (or hiding inside) confirmed reporting.
        if (isWeak(articles[i]) !== isWeak(articles[j])) continue;
        if (daysBetween(articles[i].publishedAt, articles[j].publishedAt) > options.maxDaysApart) continue;
        if (cosine(vectors[i], vectors[j]) >= options.similarityThreshold) parent[find(i)] = find(j);
      }
    }

    const groups = new Map<number, ClusterableArticle[]>();
    articles.forEach((a, i) => {
      const root = find(i);
      groups.set(root, [...(groups.get(root) ?? []), a]);
    });

    return [...groups.values()]
      .map((members) => {
        const byDate = [...members].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
        const representative = [...members].sort(
          (a, b) =>
            Number(a.injectionSuspected ?? false) - Number(b.injectionSuspected ?? false) ||
            CREDIBILITY_RANK[b.credibility] - CREDIBILITY_RANK[a.credibility] ||
            a.publishedAt.localeCompare(b.publishedAt),
        )[0];
        return {
          clusterId: '',
          articleIds: byDate.map((a) => a.id),
          representativeId: representative.id,
          headline: representative.title,
          outlets: [...new Set(byDate.map((a) => a.outlet))],
          firstPublishedAt: byDate[0].publishedAt,
          lastPublishedAt: byDate[byDate.length - 1].publishedAt,
        };
      })
      .sort((a, b) => a.firstPublishedAt.localeCompare(b.firstPublishedAt))
      .map((c, i) => ({ ...c, clusterId: `story-${i + 1}` }));
  }

  private vectorize(articles: ClusterableArticle[]): Map<string, number>[] {
    const docs = articles.map((a) => tokenize(`${a.title} ${splitSentences(a.content)[0] ?? ''}`));
    const df = new Map<string, number>();
    for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length;
    return docs.map((doc) => {
      const tf = new Map<string, number>();
      for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
      const vec = new Map<string, number>();
      for (const [t, f] of tf) vec.set(t, f * (Math.log((1 + n) / (1 + (df.get(t) ?? 0))) + 1));
      return vec;
    });
  }
}

function isWeak(a: ClusterableArticle): boolean {
  return a.credibility === 'low' || Boolean(a.injectionSuspected);
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of a) {
    na += w * w;
    const wb = b.get(t);
    if (wb) dot += w * wb;
  }
  for (const w of b.values()) nb += w * w;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
