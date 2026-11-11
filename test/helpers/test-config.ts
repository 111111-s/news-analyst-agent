import { AppConfig } from '../../src/config/app-config';

/** Deterministic config for tests: offline model, local corpus, no disk persistence, no backoff delays. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    llmProvider: 'offline',
    openRouterBaseUrl: 'https://openrouter.ai/api/v1',
    llmModel: 'openai/gpt-6.1-terra',
    llmMaxTokens: 8000,
    llmTimeoutMs: 30000,
    llmMaxRetries: 2,
    newsProvider: 'local',
    newsCorpusPath: 'data/news-corpus.json',
    newsSourcesPath: 'data/sources.json',
    localNewsFailFirstN: 0,
    agentMaxIterations: 6,
    agentMaxToolCalls: 20,
    agentMaxRepairs: 2,
    toolTimeoutMs: 5000,
    retryBaseDelayMs: 0,
    runsDir: '',
    traceLlmPayloads: false,
    ...overrides,
  };
}
