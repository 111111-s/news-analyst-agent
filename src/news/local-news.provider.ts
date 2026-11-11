import { readFileSync } from 'node:fs';
import { TransientError } from '../common/retry';
import { splitSentences, tokenize, truncate } from '../common/text';
import { Article, ArticleSummary, NewsProvider, SearchParams } from './news.types';
import { SourceCredibilityService } from './source-credibility.service';

interface CorpusFile {
  articles: Array<Omit<Article, 'credibility'>>;
}

interface IndexedArticle {
  article: Article;
  termFreq: Map<string, number>;
  length: number;
}

/**
 * Searchable local news corpus with BM25 ranking. Deterministic: used by tests, demos and offline runs.
 * `failFirstN` makes the first N searches throw a TransientError to demonstrate retries in traces.
 */
export class LocalNewsProvider implements NewsProvider {
  readonly name = 'local';
  private readonly docs: IndexedArticle[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;
  private searchCalls = 0;

  constructor(
    corpusPath: string,
    credibility: SourceCredibilityService,
    private readonly failFirstN = 0,
  ) {
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusFile;
    this.docs = corpus.articles.map((raw) => {
      const article: Article = { ...raw, credibility: credibility.lookup(raw.outlet, raw.url) };
      // Title terms count double: headlines are the strongest relevance signal.
      const terms = [...tokenize(article.title), ...tokenize(article.title), ...tokenize(article.body)];
      const termFreq = new Map<string, number>();
      for (const t of terms) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
      return { article, termFreq, length: terms.length };
    });
    for (const doc of this.docs) {
      for (const term of doc.termFreq.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
    this.avgLength = this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.docs.length);
  }

  async search(params: SearchParams): Promise<ArticleSummary[]> {
    this.searchCalls++;
    if (this.searchCalls <= this.failFirstN) {
      throw new TransientError(`simulated upstream timeout (search call #${this.searchCalls})`);
    }
    const queryTerms = [...new Set(tokenize(params.query))];
    if (queryTerms.length === 0) return [];
    const fromMs = Date.parse(`${params.from}T00:00:00Z`);
    const toMs = Date.parse(`${params.to}T23:59:59Z`);

    const scored = this.docs
      .filter((d) => {
        const t = Date.parse(d.article.publishedAt);
        return t >= fromMs && t <= toMs && d.article.language === params.language;
      })
      .map((d) => ({ doc: d, score: this.bm25(queryTerms, d) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return [];
    // Relative cut-off drops weak matches (e.g. a single shared generic word).
    const cutoff = scored[0].score * 0.3;
    return scored
      .filter((s) => s.score >= cutoff)
      .slice(0, params.limit)
      .map(({ doc, score }) => ({
        id: doc.article.id,
        title: doc.article.title,
        outlet: doc.article.outlet,
        url: doc.article.url,
        publishedAt: doc.article.publishedAt,
        credibility: doc.article.credibility,
        snippet: truncate(splitSentences(doc.article.body)[0] ?? '', 240),
        score: Math.round(score * 1000) / 1000,
      }));
  }

  async getArticle(id: string): Promise<Article | null> {
    return this.docs.find((d) => d.article.id === id)?.article ?? null;
  }

  private bm25(queryTerms: string[], doc: IndexedArticle): number {
    const k1 = 1.2;
    const b = 0.75;
    const n = this.docs.length;
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const df = this.docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.avgLength));
    }
    return score;
  }
}
