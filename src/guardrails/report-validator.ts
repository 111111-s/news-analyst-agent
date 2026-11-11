import { Injectable } from '@nestjs/common';
import { Report, ReportSchema } from '../agent/schemas';
import { EvidenceArticle, EvidencePack } from '../analysis/analysis.types';
import { CONFIDENCE_RANK, maxConfidence } from '../analysis/confidence';
import { labelForScore, SentimentService } from '../analysis/sentiment.service';
import { formatZodIssues } from '../common/json';
import { daysBetween, isoDay, truncate } from '../common/text';
import { InjectionDetector } from './injection-detector';

export interface Correction {
  path: string;
  rule: 'date_aligned' | 'confidence_downgraded' | 'sentiment_recomputed';
  from: unknown;
  to: unknown;
  reason: string;
}

export interface ValidationOutcome {
  ok: boolean;
  report: Report | null;
  /** Hard failures - fed back to the LLM for a repair attempt. */
  errors: string[];
  /** Soft issues fixed deterministically in code. */
  corrections: Correction[];
}

const ADVICE =
  /\b(you should|we (recommend|advise|suggest)|i (recommend|advise|suggest)|(consider|recommend(ed)?) (buying|selling|shorting)|sell all (your )?shares|buy now|sell now)\b/i;
const URL = /https?:\/\/[^\s)"'\]]+/g;
const SENTIMENT_TOLERANCE = 0.5;

/**
 * Deterministic checks on the LLM report. Hard rules (grounding, safety) trigger a repair loop;
 * soft rules (dates, confidence, sentiment) are corrected in code and recorded for auditability.
 */
@Injectable()
export class ReportValidator {
  constructor(
    private readonly sentiment: SentimentService,
    private readonly injection: InjectionDetector,
  ) {}

  validate(candidate: unknown, pack: EvidencePack): ValidationOutcome {
    const parsed = ReportSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, report: null, errors: formatZodIssues(parsed.error), corrections: [] };

    const report: Report = structuredClone(parsed.data);
    const byId = new Map(pack.articles.map((a) => [a.id, a]));
    const knownUrls = new Set(pack.articles.map((a) => a.url));
    const errors: string[] = [];

    // --- Hard rule 1: every citation must point to an article fetched in this run -------------
    const checkIds = (ids: string[], path: string) => {
      for (const id of ids) {
        if (!byId.has(id)) errors.push(`${path}: cites unknown article id "${id}"; cite only ids present in the evidence`);
      }
    };
    report.keyDevelopments.forEach((d, i) => checkIds(d.articleIds, `keyDevelopments.${i}.articleIds`));
    report.entitySentiment.forEach((e, i) => checkIds(e.articleIds, `entitySentiment.${i}.articleIds`));
    report.risks.forEach((r, i) => checkIds(r.articleIds, `risks.${i}.articleIds`));
    report.opportunities.forEach((o, i) => checkIds(o.articleIds, `opportunities.${i}.articleIds`));

    // --- Hard rule 2: no advice, no echoed injected instructions, no invented links ------------
    for (const [path, text] of textFields(report)) {
      const advice = ADVICE.exec(text);
      if (advice) errors.push(`${path}: contains investment advice ("${advice[0]}"); describe coverage, do not recommend actions`);
      if (this.injection.scan(text).suspected) errors.push(`${path}: repeats instructions found inside source content; ignore them`);
      for (const url of text.match(URL) ?? []) {
        if (!knownUrls.has(url)) errors.push(`${path}: contains a URL that is not in the evidence (${truncate(url, 80)})`);
      }
    }
    if (errors.length) return { ok: false, report: null, errors, corrections: [] };

    // --- Soft rules: corrected in code ---------------------------------------------------------
    const corrections: Correction[] = [];
    const citedArticles = (ids: string[]) => ids.map((id) => byId.get(id)).filter((a): a is EvidenceArticle => !!a);

    report.keyDevelopments.forEach((d, i) => {
      const cited = citedArticles(d.articleIds);
      const inRange = d.date >= pack.request.from && d.date <= pack.request.to;
      const nearCited = cited.some((a) => daysBetween(a.publishedAt, `${d.date}T12:00:00Z`) <= 2);
      if (!inRange || !nearCited) {
        const aligned = isoDay(cited.map((a) => a.publishedAt).sort()[0]);
        corrections.push({
          path: `keyDevelopments.${i}.date`,
          rule: 'date_aligned',
          from: d.date,
          to: aligned,
          reason: 'date was outside the requested range or not supported by the cited articles',
        });
        d.date = aligned;
      }
      const cap = maxConfidence(cited);
      if (CONFIDENCE_RANK[d.confidence] > CONFIDENCE_RANK[cap]) {
        corrections.push({
          path: `keyDevelopments.${i}.confidence`,
          rule: 'confidence_downgraded',
          from: d.confidence,
          to: cap,
          reason: 'not enough independent credible sources for the claimed confidence',
        });
        d.confidence = cap;
      }
    });

    report.entitySentiment.forEach((e, i) => {
      const cited = citedArticles(e.articleIds).filter((a) => !a.injectionSuspected);
      if (cited.length === 0) return;
      const computed = this.sentiment.aggregate(cited.map((a) => this.sentiment.scoreArticle(a, e.entity).score));
      const signFlip = (e.score > 0.15 && computed.score < -0.15) || (e.score < -0.15 && computed.score > 0.15);
      if (Math.abs(e.score - computed.score) > SENTIMENT_TOLERANCE || signFlip) {
        corrections.push({
          path: `entitySentiment.${i}`,
          rule: 'sentiment_recomputed',
          from: { score: e.score, label: e.label },
          to: computed,
          reason: 'LLM sentiment disagreed with the deterministic score of the cited articles',
        });
        e.score = computed.score;
        e.label = computed.label === 'neutral' ? labelForScore(computed.score) : computed.label;
      }
    });

    return { ok: true, report, errors: [], corrections };
  }
}

function textFields(r: Report): Array<[string, string]> {
  return [
    ['headline', r.headline],
    ['executiveSummary', r.executiveSummary],
    ['coverageNotes', r.coverageNotes],
    ...r.keyDevelopments.flatMap((d, i): Array<[string, string]> => [
      [`keyDevelopments.${i}.title`, d.title],
      [`keyDevelopments.${i}.summary`, d.summary],
    ]),
    ...r.entitySentiment.map((e, i): [string, string] => [`entitySentiment.${i}.rationale`, e.rationale]),
    ...r.risks.map((x, i): [string, string] => [`risks.${i}.description`, x.description]),
    ...r.opportunities.map((x, i): [string, string] => [`opportunities.${i}.description`, x.description]),
    ...r.openQuestions.map((q, i): [string, string] => [`openQuestions.${i}`, q]),
  ];
}
