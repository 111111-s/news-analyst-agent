import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { TransientError } from '../common/retry';
import { truncate } from '../common/text';
import { Article, ArticleSummary, NewsProvider, SearchParams } from './news.types';
import { SourceCredibilityService } from './source-credibility.service';

type FetchFn = typeof fetch;

interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  source?: string | { '#text'?: string; '@_url'?: string };
}

/**
 * Live news via the public Google News RSS search endpoint (no API key).
 * RSS gives headline + snippet only; we do not scrape publisher pages (licensing, robots.txt, paywalls),
 * so `getArticle` returns the RSS snippet as the article body.
 */
export class RssNewsProvider implements NewsProvider {
  readonly name = 'rss';
  private readonly cache = new Map<string, Article>();
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  constructor(
    private readonly credibility: SourceCredibilityService,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async search(params: SearchParams): Promise<ArticleSummary[]> {
    // Google News supports after:/before: operators; `before` is exclusive, so add one day.
    const before = new Date(Date.parse(`${params.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const q = `${params.query} after:${params.from} before:${before}`;
    const lang = params.language || 'en';
    const url =
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
      `&hl=${lang}&gl=US&ceid=US:${lang}`;

    let xml: string;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 429 || res.status >= 500) throw new TransientError(`RSS upstream returned ${res.status}`);
      if (!res.ok) throw new Error(`RSS upstream returned ${res.status}`);
      xml = await res.text();
    } catch (error) {
      if (error instanceof TransientError) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'TypeError')) {
        throw new TransientError(`RSS request failed: ${error.message}`, error);
      }
      throw error;
    }
    return this.parse(xml, params);
  }

  async getArticle(id: string): Promise<Article | null> {
    return this.cache.get(id) ?? null;
  }

  /** Exposed for unit tests. */
  parse(xml: string, params: SearchParams): ArticleSummary[] {
    const doc = this.parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
    const raw = doc.rss?.channel?.item;
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const fromMs = Date.parse(`${params.from}T00:00:00Z`);
    const toMs = Date.parse(`${params.to}T23:59:59Z`);

    const results: ArticleSummary[] = [];
    items.forEach((item, index) => {
      if (!item.title || !item.link) return;
      const publishedAt = item.pubDate ? new Date(item.pubDate) : null;
      if (!publishedAt || Number.isNaN(publishedAt.getTime())) return;
      if (publishedAt.getTime() < fromMs || publishedAt.getTime() > toMs) return;
      const outlet = typeof item.source === 'string' ? item.source : (item.source?.['#text'] ?? 'Unknown outlet');
      const outletUrl = typeof item.source === 'object' ? item.source?.['@_url'] : undefined;
      const title = stripHtml(String(item.title)).replace(new RegExp(`\\s+-\\s+${escapeRegExp(outlet)}$`), '');
      // Google News descriptions usually repeat "<headline> <outlet>"; keep only genuinely new text.
      let description = stripHtml(String(item.description ?? ''));
      if (description.startsWith(title)) description = description.slice(title.length).trim();
      if (description.endsWith(outlet)) description = description.slice(0, -outlet.length).trim();
      const snippet = truncate(description, 400);
      const id = 'rss-' + createHash('sha1').update(String(item.link)).digest('hex').slice(0, 12);
      const article: Article = {
        id,
        title,
        outlet,
        url: String(item.link),
        publishedAt: publishedAt.toISOString(),
        language: params.language,
        body: snippet && snippet !== title ? `${title}. ${snippet}` : title,
        credibility: this.credibility.lookup(outlet, outletUrl),
      };
      this.cache.set(id, article);
      results.push({
        id,
        title,
        outlet,
        url: article.url,
        publishedAt: article.publishedAt,
        credibility: article.credibility,
        snippet: truncate(snippet || title, 240),
        score: 1 / (index + 1),
      });
    });
    return results.slice(0, params.limit);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
