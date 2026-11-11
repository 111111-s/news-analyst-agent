import { TransientError } from '../../src/common/retry';
import { LocalNewsProvider } from '../../src/news/local-news.provider';
import { RssNewsProvider } from '../../src/news/rss-news.provider';
import { SourceCredibilityService } from '../../src/news/source-credibility.service';
import { testConfig } from '../helpers/test-config';

const credibility = new SourceCredibilityService(testConfig());
const params = { from: '2026-10-01', to: '2026-11-10', language: 'en', limit: 10 };

describe('SourceCredibilityService', () => {
  it('looks up by outlet name and by domain', () => {
    expect(credibility.lookup('TechWire')).toBe('high');
    expect(credibility.lookup('Some Blog', 'https://www.reuters.com/x')).toBe('high');
    expect(credibility.lookup('Unknown Daily', 'https://unknown.example')).toBe('unknown');
  });
});

describe('LocalNewsProvider', () => {
  const provider = new LocalNewsProvider('data/news-corpus.json', credibility);

  it('ranks relevant articles and enforces the date range', async () => {
    const results = await provider.search({ ...params, query: 'Northwind Robotics recall' });
    expect(results[0].id).toMatch(/^nw-00[45]$/);
    expect(results.map((r) => r.id)).not.toContain('nw-000'); // published in 2025
    expect(results.every((r) => r.publishedAt >= '2026-10-01')).toBe(true);
  });

  it('returns nothing for unrelated queries', async () => {
    expect(await provider.search({ ...params, query: 'quantum computing antarctica' })).toEqual([]);
  });

  it('attaches credibility and fetches by id', async () => {
    const article = await provider.getArticle('nw-006');
    expect(article?.credibility).toBe('low');
    expect(await provider.getArticle('missing')).toBeNull();
  });

  it('can simulate transient upstream failures', async () => {
    const flaky = new LocalNewsProvider('data/news-corpus.json', credibility, 1);
    await expect(flaky.search({ ...params, query: 'Helios' })).rejects.toBeInstanceOf(TransientError);
    await expect(flaky.search({ ...params, query: 'Helios' })).resolves.not.toHaveLength(0);
  });
});

describe('RssNewsProvider', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Acme wins contract - Reuters</title><link>https://news.example/a</link>
      <pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description>&lt;a href="x"&gt;Acme wins big contract&lt;/a&gt;</description>
      <source url="https://www.reuters.com">Reuters</source></item>
    <item><title>Old story</title><link>https://news.example/b</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>
  </channel></rss>`;

  it('parses items, strips HTML, filters by date and caches articles', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml });
    const provider = new RssNewsProvider(credibility, fetchFn as unknown as typeof fetch);
    const results = await provider.search({ ...params, query: 'Acme' });
    expect(fetchFn.mock.calls[0][0]).toContain('news.google.com/rss/search?q=Acme');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Acme wins contract', outlet: 'Reuters', credibility: 'high' });
    const article = await provider.getArticle(results[0].id);
    expect(article?.body).toContain('Acme wins big contract');
  });

  it('maps 5xx responses to transient errors', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    const provider = new RssNewsProvider(credibility, fetchFn as unknown as typeof fetch);
    await expect(provider.search({ ...params, query: 'Acme' })).rejects.toBeInstanceOf(TransientError);
  });
});
