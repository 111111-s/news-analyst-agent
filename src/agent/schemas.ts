import { z } from 'zod';
import { daysBetween } from '../common/text';

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'must be a valid calendar date');

// ---------------------------------------------------------------------------------------------
// Input contract (HTTP body / CLI). Strict: unknown fields are rejected.
// ---------------------------------------------------------------------------------------------
export const AnalyzeRequestSchema = z
  .object({
    query: z.string().trim().min(3, 'query must be at least 3 characters').max(500, 'query must be at most 500 characters'),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    language: z.string().regex(/^[a-z]{2}$/, 'language must be an ISO 639-1 code like "en"').default('en'),
    maxArticles: z.number().int().min(1).max(15).default(8),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.from && v.to && v.from > v.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: '`from` must be on or before `to`' });
    }
    if (v.from && v.to && daysBetween(v.from, v.to) > 366) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'date range must not exceed 366 days' });
    }
  });

export type AnalyzeRequestInput = z.input<typeof AnalyzeRequestSchema>;

export interface NormalizedRequest {
  query: string;
  from: string;
  to: string;
  language: string;
  maxArticles: number;
}

// ---------------------------------------------------------------------------------------------
// LLM output contracts. All fields required (nullable instead of optional) so the JSON schema
// works with OpenAI strict structured outputs. Limits are enforced by zod after parsing.
// ---------------------------------------------------------------------------------------------
export const INTENTS = ['company_brief', 'topic_overview', 'comparison', 'event_tracking', 'out_of_scope'] as const;
export type Intent = (typeof INTENTS)[number];

export const PlanSchema = z.object({
  intent: z.enum(INTENTS).describe('Type of analysis requested'),
  entities: z.array(z.string().min(1).max(80)).max(5).describe('Companies, organisations, places or topics to track'),
  searchQueries: z
    .array(z.string().min(2).max(120))
    .max(5)
    .describe('1-5 short keyword queries for a news search engine (not questions). Empty only when refusing.'),
  focus: z.array(z.string().min(1).max(120)).max(5).describe('Aspects the analyst cares about'),
  refuse: z.boolean().describe('true if the request is not a legitimate news research task'),
  refusalReason: z.string().max(300).nullable().describe('Short reason when refuse=true, otherwise null'),
});
export type Plan = z.infer<typeof PlanSchema>;

export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const SENTIMENT_LABELS = ['positive', 'neutral', 'negative', 'mixed'] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

const Citations = z
  .array(z.string().min(1).max(64))
  .min(1, 'at least one article id must be cited')
  .max(10)
  .describe('Ids of evidence articles that support this item');

export const ReportSchema = z.object({
  headline: z.string().min(5).max(200),
  executiveSummary: z.string().min(10).max(1500).describe('3-6 sentences, only facts present in the evidence'),
  keyDevelopments: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        summary: z.string().min(3).max(600),
        date: IsoDate.describe('Date of the development (YYYY-MM-DD), taken from the cited articles'),
        articleIds: Citations,
        confidence: z.enum(CONFIDENCE),
      }),
    )
    .max(10),
  entitySentiment: z
    .array(
      z.object({
        entity: z.string().min(1).max(80),
        label: z.enum(SENTIMENT_LABELS),
        score: z.number().min(-1).max(1),
        rationale: z.string().max(300),
        articleIds: Citations,
      }),
    )
    .max(6),
  risks: z.array(z.object({ description: z.string().min(3).max(400), articleIds: Citations })).max(6),
  opportunities: z.array(z.object({ description: z.string().min(3).max(400), articleIds: Citations })).max(6),
  openQuestions: z.array(z.string().min(3).max(300)).max(5),
  coverageNotes: z.string().max(800).describe('Gaps, source quality caveats, limitations'),
});
export type Report = z.infer<typeof ReportSchema>;
