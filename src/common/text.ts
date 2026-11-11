/** Small, dependency-free text helpers used by search, clustering and sentiment scoring. */

const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does for from had has have he her his how i if in into is it its ' +
    'me my no not of on or our out over said says she so than that the their them then there these they this those to under up ' +
    'us was we were what when where which while who whom why will with would you your about after all also any because before ' +
    'between both each few more most other same some such only own very just now new news latest recent what\'s'
  ).split(/\s+/),
);

/** Light stemmer: enough to match "recalls"/"recall", "launches"/"launch", "companies"/"company". */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && /(sses|shes|ches|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}$%\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** YYYY-MM-DD for a Date or ISO string (UTC). */
export function isoDay(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string | Date, b: string | Date): number {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return ms / 86_400_000;
}
