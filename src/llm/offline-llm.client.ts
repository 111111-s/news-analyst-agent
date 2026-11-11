import type { NormalizedRequest, Plan } from '../agent/schemas';
import type { EvidencePack } from '../analysis/analysis.types';
import { ExtractiveReportBuilder } from '../analysis/extractive-report.builder';
import { tokenize, unique } from '../common/text';
import { ChatMessage, ChatRequest, ChatResponse, LlmClient, LlmToolCall, messageText } from './llm.types';

/** Words that start questions/commands and are never entity names. */
const NON_ENTITY_WORDS = new Set(
  (
    'what whats how why who when where which is are was were can could should would will do does did please tell show give find ' +
    'summarize summarise compare comparison overview analyze analyse write create i we you me my our the a an any latest recent news ' +
    'update updates report brief'
  ).split(' '),
);

/** Query words that carry no search value. */
const GENERIC_TERMS = new Set(
  tokenize(
    'news coverage recent latest happening happen overview compare comparison situation effect effects impact far ' +
      'tell show give summary summarize analysis analyze report update updates buy sell stock stocks share shares invest ' +
      'investment now today week month year going brief',
  ),
);

/**
 * Deterministic stand-in for the LLM. It follows the exact same protocol as the real model
 * (structured JSON for plan/report, tool calls in the research loop) so the whole orchestrator,
 * tool layer and validators are exercised without network access. It is NOT a quality benchmark:
 * the real reasoning happens with LLM_PROVIDER=openrouter.
 */
export class OfflineLlmClient implements LlmClient {
  readonly provider = 'offline';
  readonly model = 'offline-heuristic-v1';
  private callCounter = 0;

  constructor(private readonly reportBuilder: ExtractiveReportBuilder) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    switch (request.stage) {
      case 'plan':
        return this.respond(request, JSON.stringify(this.plan(request.messages)));
      case 'research':
        return this.research(request);
      case 'analyze': {
        const pack = parseTagged<EvidencePack>(request.messages, 'evidence');
        return this.respond(request, JSON.stringify(this.reportBuilder.build(pack)));
      }
    }
  }

  private plan(messages: ChatMessage[]): Plan {
    const req = parseTagged<NormalizedRequest>(messages, 'request');
    const query = req.query;
    const entities = extractEntities(query);
    const entityTokens = new Set(entities.flatMap((e) => tokenize(e)));
    const keywords = unique(tokenize(query)).filter((t) => !entityTokens.has(t) && !GENERIC_TERMS.has(t));

    let intent: Plan['intent'];
    if (/\b(compare|comparison|versus|vs\.?)\b/i.test(query) || (entities.length >= 2 && /\band\b/i.test(query))) intent = 'comparison';
    else if (/\b(breach|hack|outage|recall|strike|lawsuit|incident|crisis|accident|confirmed|investigation)\b/i.test(query)) intent = 'event_tracking';
    else if (/\b(overview|trends?|landscape|situation|sector|industry|market)\b/i.test(query)) intent = 'topic_overview';
    else intent = entities.length ? 'company_brief' : 'topic_overview';

    let searchQueries: string[];
    if (intent === 'comparison' && entities.length >= 2) searchQueries = entities.slice(0, 5);
    else if (entities.length) searchQueries = unique([`${entities[0]} ${keywords.slice(0, 4).join(' ')}`.trim(), entities[0]]);
    else searchQueries = [keywords.slice(0, 6).join(' ') || query];

    return { intent, entities: entities.slice(0, 5), searchQueries, focus: keywords.slice(0, 5), refuse: false, refusalReason: null };
  }

  private research(request: ChatRequest): ChatResponse {
    const plan = parseTagged<Plan>(request.messages, 'plan');
    const req = parseTagged<NormalizedRequest>(request.messages, 'request');
    const history = toolHistory(request.messages);
    const calls = (name: string) => history.filter((h) => h.name === name);

    if (calls('search_news').length === 0) {
      return this.respondTools(
        request,
        plan.searchQueries.slice(0, 5).map((query) => ({ name: 'search_news', args: { query, limit: 10 } })),
      );
    }

    if (calls('fetch_article').length === 0) {
      // Round-robin over queries so every entity of a comparison gets coverage.
      const lists = calls('search_news').map((c) => (c.result?.ok ? (c.result.data as { results: { id: string }[] }).results : []));
      const picked: string[] = [];
      for (let rank = 0; picked.length < req.maxArticles && lists.some((l) => l.length > rank); rank++) {
        for (const list of lists) {
          const id = list[rank]?.id;
          if (id && !picked.includes(id) && picked.length < req.maxArticles) picked.push(id);
        }
      }
      if (picked.length === 0) return this.respond(request, 'No relevant articles found.');
      return this.respondTools(request, picked.map((articleId) => ({ name: 'fetch_article', args: { articleId } })));
    }

    if (calls('cluster_stories').length === 0) {
      const ids = calls('fetch_article')
        .filter((c) => c.result?.ok)
        .map((c) => (c.result!.data as { id: string }).id);
      if (ids.length === 0) return this.respond(request, 'Could not fetch any article.');
      return this.respondTools(request, [
        { name: 'cluster_stories', args: { articleIds: ids } },
        { name: 'analyze_sentiment', args: { articleIds: ids, entity: plan.entities[0] ?? null } },
      ]);
    }

    return this.respond(request, `Research complete: ${calls('fetch_article').length} article(s) fetched.`);
  }

  private respondTools(request: ChatRequest, calls: Array<{ name: string; args: unknown }>): ChatResponse {
    const toolCalls: LlmToolCall[] = calls.map((c) => ({
      id: `call_${++this.callCounter}`,
      name: c.name,
      arguments: JSON.stringify(c.args),
    }));
    return { ...this.respond(request, null), toolCalls, finishReason: 'tool_calls' };
  }

  private respond(request: ChatRequest, content: string | null): ChatResponse {
    const promptChars = request.messages.reduce((n, m) => n + messageText(m).length, 0);
    return {
      content,
      toolCalls: [],
      finishReason: 'stop',
      refusal: null,
      model: this.model,
      usage: { promptTokens: Math.ceil(promptChars / 4), completionTokens: Math.ceil((content?.length ?? 0) / 4) },
    };
  }
}

/** Capitalised phrases ("Northwind Robotics", "Port of Marisol"), minus question words. */
export function extractEntities(query: string): string[] {
  const matches = query.match(/\b[A-Z][\p{L}\p{N}&'-]*(?:\s+(?:of\s+|for\s+|de\s+|&\s+)?[A-Z][\p{L}\p{N}&'-]*)*/gu) ?? [];
  const entities: string[] = [];
  for (const raw of matches) {
    const words = raw.split(/\s+/);
    while (words.length && NON_ENTITY_WORDS.has(words[0].toLowerCase())) words.shift();
    const entity = words.join(' ').replace(/^(of|for|de|&)\s+/i, '').trim();
    if (entity.length >= 2 && !NON_ENTITY_WORDS.has(entity.toLowerCase())) entities.push(entity);
  }
  return unique(entities);
}

function parseTagged<T>(messages: ChatMessage[], tag: string): T {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const match = re.exec(messageText(message));
    if (match) return JSON.parse(match[1]) as T;
  }
  throw new Error(`offline model: <${tag}> block not found in prompt`);
}

interface ToolHistoryItem {
  name: string;
  result?: { ok: boolean; data?: unknown };
}

function toolHistory(messages: ChatMessage[]): ToolHistoryItem[] {
  const names = new Map<string, string>();
  const items: ToolHistoryItem[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) if (tc.type === 'function') names.set(tc.id, tc.function.name);
    }
    if (m.role === 'tool') {
      let result: ToolHistoryItem['result'];
      try {
        result = JSON.parse(messageText(m)) as ToolHistoryItem['result'];
      } catch {
        result = { ok: false };
      }
      items.push({ name: names.get(m.tool_call_id) ?? 'unknown', result });
    }
  }
  return items;
}
