import { Injectable } from '@nestjs/common';
import type { Intent, NormalizedRequest, Report } from '../agent/schemas';
import { isoDay, splitSentences, truncate } from '../common/text';
import { EvidenceArticle, EvidencePack, StoryCluster } from './analysis.types';
import { maxConfidence } from './confidence';
import { entityMentioned, SENTIMENT_THRESHOLD, SentimentService } from './sentiment.service';

export const INJECTION_PLACEHOLDER = '[removed: suspected prompt injection]';

/**
 * Builds a report purely from evidence, without an LLM: every sentence is extracted from a cited
 * article and every number is computed. Used (1) as the graceful-degradation fallback when LLM
 * synthesis fails validation and (2) as the "model" in offline mode.
 */
@Injectable()
export class ExtractiveReportBuilder {
  constructor(private readonly sentiment: SentimentService) {}

  build(pack: EvidencePack): Report {
    const { request, plan } = pack;
    const byId = new Map(pack.articles.map((a) => [a.id, a]));
    const cited = (c: StoryCluster) => c.articleIds.map((id) => byId.get(id)).filter((a): a is EvidenceArticle => !!a);

    const clusters = [...pack.clusters].sort((a, b) => a.firstPublishedAt.localeCompare(b.firstPublishedAt));
    const developments = clusters.slice(0, 8).map((c) => {
      const rep = byId.get(c.representativeId) ?? cited(c)[0];
      return {
        title: truncate(rep.title, 200),
        summary: truncate(leadSentences(rep.content, 2) || rep.title, 600),
        date: isoDay(c.firstPublishedAt),
        articleIds: c.articleIds.slice(0, 10),
        confidence: maxConfidence(cited(c)),
        tone: this.sentiment.aggregate(cited(c).map((a) => a.sentimentScore)).score,
      };
    });

    const entitySentiment = plan.entities.slice(0, 6).flatMap((entity) => {
      const related = pack.articles.filter((a) => !a.injectionSuspected && entityMentioned(`${a.title} ${a.content}`, entity));
      if (related.length === 0) return [];
      const scores = related.map((a) => this.sentiment.scoreArticle(a, entity).score);
      const agg = this.sentiment.aggregate(scores);
      const pos = scores.filter((s) => s > SENTIMENT_THRESHOLD).length;
      const neg = scores.filter((s) => s < -SENTIMENT_THRESHOLD).length;
      return [
        {
          entity,
          label: agg.label,
          score: agg.score,
          rationale: `Lexicon scoring of ${related.length} article(s): ${pos} positive, ${neg} negative, ${related.length - pos - neg} neutral.`,
          articleIds: related.slice(0, 10).map((a) => a.id),
        },
      ];
    });

    // Unconfirmed stories are surfaced as open questions, not as risks/opportunities.
    const confirmed = developments.filter((d) => d.confidence !== 'low');
    const risks = confirmed
      .filter((d) => d.tone < -SENTIMENT_THRESHOLD)
      .slice(0, 6)
      .map((d) => ({ description: `${d.title} (${d.date})`, articleIds: d.articleIds }));
    const opportunities = confirmed
      .filter((d) => d.tone > SENTIMENT_THRESHOLD)
      .slice(0, 6)
      .map((d) => ({ description: `${d.title} (${d.date})`, articleIds: d.articleIds }));
    const openQuestions = developments
      .filter((d) => d.confidence === 'low')
      .slice(0, 5)
      .map((d) => truncate(`Unconfirmed: "${d.title}" is supported only by low-credibility or flagged sources.`, 300));

    const outlets = new Set(pack.articles.map((a) => a.outlet));
    const keyStories = [...developments]
      .sort((a, b) => b.articleIds.length - a.articleIds.length || a.date.localeCompare(b.date))
      .filter((d) => d.confidence !== 'low')
      .slice(0, 3)
      .map((d) => `${d.title} (${d.date})`);
    const toneSentences = entitySentiment.map((e) => `Overall tone toward ${e.entity}: ${e.label} (${e.score}).`);
    const lowCount = developments.filter((d) => d.confidence === 'low').length;

    const executiveSummary = truncate(
      [
        `Between ${request.from} and ${request.to}, ${pack.articles.length} article(s) from ${outlets.size} outlet(s) were analysed, forming ${developments.length} distinct stor${developments.length === 1 ? 'y' : 'ies'}.`,
        keyStories.length ? `Most covered: ${keyStories.join('; ')}.` : '',
        ...toneSentences,
        lowCount ? `${lowCount} stor${lowCount === 1 ? 'y relies' : 'ies rely'} only on low-credibility or flagged sources and ${lowCount === 1 ? 'is' : 'are'} treated as unconfirmed.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      1500,
    );

    return {
      headline: truncate(this.headline(plan.intent, plan.entities, request), 200),
      executiveSummary,
      keyDevelopments: developments.map(({ tone: _tone, ...d }) => d),
      entitySentiment,
      risks,
      opportunities,
      openQuestions,
      coverageNotes: this.coverageNotes(pack),
    };
  }

  /** Report for runs where search found nothing relevant: says so instead of inventing content. */
  buildEmpty(request: NormalizedRequest, entities: string[]): Report {
    const subject = entities[0] ?? request.query;
    return {
      headline: truncate(`${subject}: no relevant coverage found (${request.from} – ${request.to})`, 200),
      executiveSummary: `No articles matching the request were found between ${request.from} and ${request.to}. No developments are reported to avoid unsupported claims.`,
      keyDevelopments: [],
      entitySentiment: [],
      risks: [],
      opportunities: [],
      openQuestions: [],
      coverageNotes: 'Insufficient data: try a wider date range, different keywords or another news provider.',
    };
  }

  private headline(intent: Intent, entities: string[], r: NormalizedRequest): string {
    const subject = entities[0] ?? truncate(r.query, 60);
    const period = `(${r.from} – ${r.to})`;
    switch (intent) {
      case 'comparison':
        return `${entities.length > 1 ? entities.join(' vs ') : subject}: coverage comparison ${period}`;
      case 'event_tracking':
        return `${subject}: event tracker ${period}`;
      case 'topic_overview':
        return `${subject}: topic overview ${period}`;
      default:
        return `${subject}: news brief ${period}`;
    }
  }

  private coverageNotes(pack: EvidencePack): string {
    const count = (c: string) => pack.articles.filter((a) => a.credibility === c).length;
    const flagged = pack.articles.filter((a) => a.injectionSuspected).length;
    const notes = [
      `Source mix: ${count('high')} high, ${count('medium')} medium, ${count('low')} low and ${count('unknown')} unknown-credibility article(s).`,
      flagged
        ? `${flagged} article(s) contained text addressed to AI systems; it was removed and those articles cannot raise a claim above low confidence.`
        : '',
      'Sentiment is lexicon-based and indicative only.',
    ];
    return truncate(notes.filter(Boolean).join(' '), 800);
  }
}

function leadSentences(text: string, count: number): string {
  return splitSentences(text)
    .filter((s) => !s.includes(INJECTION_PLACEHOLDER))
    .slice(0, count)
    .join(' ');
}
