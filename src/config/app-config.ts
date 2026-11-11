import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LLM_PROVIDER: z.enum(['openrouter', 'offline', '']).optional(),
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_MODEL: z.string().min(1).default('openai/gpt-6.1-terra'),
  LLM_TEMPERATURE: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(2).optional()),
  LLM_REASONING_EFFORT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['minimal', 'low', 'medium', 'high']).optional()),
  LLM_MAX_TOKENS: z.coerce.number().int().min(256).max(128000).default(8000),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(2),
  NEWS_PROVIDER: z.enum(['local', 'rss']).default('local'),
  NEWS_CORPUS_PATH: z.string().default('data/news-corpus.json'),
  NEWS_SOURCES_PATH: z.string().default('data/sources.json'),
  LOCAL_NEWS_FAIL_FIRST_N: z.coerce.number().int().min(0).default(0),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(6),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(100).default(20),
  AGENT_MAX_REPAIRS: z.coerce.number().int().min(0).max(5).default(2),
  TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).default(15000),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(500),
  RUNS_DIR: z.string().default('runs'),
  TRACE_LLM_PAYLOADS: bool,
  API_AUTH_TOKEN: optionalString,
});

export interface AppConfig {
  port: number;
  llmProvider: 'openrouter' | 'offline';
  openRouterApiKey?: string;
  openRouterBaseUrl: string;
  llmModel: string;
  llmTemperature?: number;
  llmReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  llmMaxTokens: number;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  newsProvider: 'local' | 'rss';
  newsCorpusPath: string;
  newsSourcesPath: string;
  localNewsFailFirstN: number;
  agentMaxIterations: number;
  agentMaxToolCalls: number;
  agentMaxRepairs: number;
  toolTimeoutMs: number;
  retryBaseDelayMs: number;
  /** Empty string disables persistence of results/traces to disk. */
  runsDir: string;
  traceLlmPayloads: boolean;
  apiAuthToken?: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }
  const e = parsed.data;
  const llmProvider = e.LLM_PROVIDER ? e.LLM_PROVIDER : e.OPENROUTER_API_KEY ? 'openrouter' : 'offline';
  if (llmProvider === 'openrouter' && !e.OPENROUTER_API_KEY) {
    throw new ConfigError('LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY (get one at https://openrouter.ai/keys)');
  }
  return {
    port: e.PORT,
    llmProvider,
    openRouterApiKey: e.OPENROUTER_API_KEY,
    openRouterBaseUrl: e.OPENROUTER_BASE_URL,
    llmModel: e.LLM_MODEL,
    llmTemperature: e.LLM_TEMPERATURE,
    llmReasoningEffort: e.LLM_REASONING_EFFORT,
    llmMaxTokens: e.LLM_MAX_TOKENS,
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    llmMaxRetries: e.LLM_MAX_RETRIES,
    newsProvider: e.NEWS_PROVIDER,
    newsCorpusPath: e.NEWS_CORPUS_PATH,
    newsSourcesPath: e.NEWS_SOURCES_PATH,
    localNewsFailFirstN: e.LOCAL_NEWS_FAIL_FIRST_N,
    agentMaxIterations: e.AGENT_MAX_ITERATIONS,
    agentMaxToolCalls: e.AGENT_MAX_TOOL_CALLS,
    agentMaxRepairs: e.AGENT_MAX_REPAIRS,
    toolTimeoutMs: e.TOOL_TIMEOUT_MS,
    retryBaseDelayMs: e.RETRY_BASE_DELAY_MS,
    runsDir: e.RUNS_DIR,
    traceLlmPayloads: e.TRACE_LLM_PAYLOADS,
    apiAuthToken: e.API_AUTH_TOKEN,
  };
}

/** Load `.env` from the working directory if present (Node >= 20.12 built-in, no dotenv dependency). */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file - fine */
  }
}
