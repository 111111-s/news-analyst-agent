import { ClusteringService } from '../../src/analysis/clustering.service';
import { maxConfidence } from '../../src/analysis/confidence';
import { SentimentService } from '../../src/analysis/sentiment.service';
import { Credibility } from '../../src/news/news.types';

const corpus = (require('../../data/news-corpus.json') as { articles: any[] }).articles;
const credibilityOf: Record<string, Credibility> = {
  'The Ledger Daily': 'high',
  TechWire: 'high',
  'Global Business Review': 'high',
  'Metro Tribune': 'medium',
  'Industry Pulse': 'medium',
  'Energy Insider': 'medium',
  'MarketBuzz Blog': 'low',
  'RumorMill News': 'low',
};
const articles = (ids: string[]) =>
  corpus
    .filter((a) => ids.includes(a.id))
    .map((a) => ({ ...a, content: a.body, credibility: credibilityOf[a.outlet] ?? 'unknown', injectionSuspected: a.id === 'nw-009' }));

describe('SentimentService', () => {
  const sentiment = new SentimentService();

  it('scores positive and negative news deterministically', () => {
    expect(sentiment.score('Northwind raises $120 million and expands manufacturing').label).toBe('positive');
    expect(sentiment.score('Northwind recalls robots over overheating defect').label).toBe('negative');
    expect(sentiment.score('The company held its annual meeting').label).toBe('neutral');
  });

  it('focuses on sentences that mention the entity', () => {
    const text = 'Helios Energy missed estimates and cut guidance. Solaris Power won a record contract.';
    expect(sentiment.score(text, 'Helios Energy').label).toBe('negative');
    expect(sentiment.score(text, 'Solaris Power').label).toBe('positive');
  });

  it('labels conflicting signals as mixed', () => {
    expect(sentiment.aggregate([0.6, -0.6]).label).toBe('mixed');
  });
});

describe('ClusteringService', () => {
  const clustering = new ClusteringService();
  const groups = (ids: string[]) => clustering.cluster(articles(ids)).map((c) => c.articleIds.join('+'));

  it('merges the same story from different outlets and separates different stories', () => {
    expect(groups(['nw-001', 'nw-002', 'nw-003', 'nw-004', 'nw-005', 'nw-007', 'nw-008', 'nw-010'])).toEqual([
      'nw-001+nw-002+nw-003',
      'nw-010',
      'nw-004+nw-005',
      'nw-007+nw-008',
    ]);
  });

  it('never merges low-credibility or flagged articles into credible stories', () => {
    expect(groups(['cn-002', 'cn-003'])).toEqual(['cn-002', 'cn-003']);
    expect(groups(['nw-007', 'nw-008', 'nw-009'])).toEqual(['nw-007+nw-008', 'nw-009']);
  });
});

describe('maxConfidence', () => {
  const a = (outlet: string, credibility: Credibility, injectionSuspected = false) => ({ outlet, credibility, injectionSuspected });

  it('requires two independent credible outlets for high confidence', () => {
    expect(maxConfidence([a('A', 'high'), a('B', 'medium')])).toBe('high');
    expect(maxConfidence([a('A', 'high'), a('A', 'high')])).toBe('medium');
    expect(maxConfidence([a('A', 'low'), a('B', 'low')])).toBe('low');
    expect(maxConfidence([a('A', 'high', true), a('B', 'low')])).toBe('low');
    expect(maxConfidence([a('A', 'unknown'), a('B', 'unknown')])).toBe('medium');
  });
});
