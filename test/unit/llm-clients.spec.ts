import OpenAI from 'openai';
import { TransientError } from '../../src/common/retry';
import { ConfigError, loadConfig } from '../../src/config/app-config';
import { LlmConfigurationError } from '../../src/llm/llm.types';
import { extractEntities } from '../../src/llm/offline-llm.client';
import { OpenRouterLlmClient } from '../../src/llm/openrouter-llm.client';
import { testConfig } from '../helpers/test-config';

describe('loadConfig', () => {
  it('defaults to the offline model when no OpenRouter key is present', () => {
    expect(loadConfig({}).llmProvider).toBe('offline');
  });

  it('uses OpenRouter when a key is present', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'sk-or-test' });
    expect(config).toMatchObject({ llmProvider: 'openrouter', llmModel: 'openai/gpt-6.1-terra', openRouterBaseUrl: 'https://openrouter.ai/api/v1' });
  });

  it('fails fast on inconsistent or invalid configuration', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'openrouter' })).toThrow(ConfigError);
    expect(() => loadConfig({ AGENT_MAX_ITERATIONS: '0' })).toThrow(ConfigError);
  });
});

describe('extractEntities (offline model)', () => {
  it.each([
    ['What is happening with Northwind Robotics?', ['Northwind Robotics']],
    ['Compare recent news coverage of Helios Energy and Solaris Power', ['Helios Energy', 'Solaris Power']],
    ['Overview of the Port of Marisol situation', ['Port of Marisol']],
    ['Should I buy Northwind Robotics stock now?', ['Northwind Robotics']],
  ])('%p -> %p', (query, expected) => {
    expect(extractEntities(query)).toEqual(expected);
  });
});

describe('OpenRouterLlmClient', () => {
  const completion = {
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'openai/gpt-6.1-terra',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_news', arguments: '{"query":"x","limit":null}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };

  function clientWith(create: jest.Mock, overrides = {}) {
    const fake = { chat: { completions: { create } } } as unknown as OpenAI;
    return new OpenRouterLlmClient(testConfig({ llmProvider: 'openrouter', openRouterApiKey: 'k', llmReasoningEffort: 'low', ...overrides }), fake);
  }

  it('sends strict structured-output + tool requests and maps tool calls', async () => {
    const create = jest.fn().mockResolvedValue(completion);
    const client = clientWith(create);
    const res = await client.chat({
      stage: 'research',
      repairAttempt: 0,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'search_news', parameters: { type: 'object' }, strict: true } }],
      responseFormat: { name: 'plan', schema: { type: 'object' } },
    });
    const body = create.mock.calls[0][0];
    expect(body).toMatchObject({
      model: 'openai/gpt-6.1-terra',
      tool_choice: 'auto',
      response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true } },
      reasoning: { effort: 'low' },
    });
    expect(body.temperature).toBeUndefined();
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'search_news', arguments: '{"query":"x","limit":null}' }]);
    expect(res.usage).toEqual({ promptTokens: 120, completionTokens: 30 });
  });

  it('treats an empty choices array as a transient upstream error', async () => {
    const client = clientWith(jest.fn().mockResolvedValue({ ...completion, choices: [] }));
    await expect(client.chat({ stage: 'plan', repairAttempt: 0, messages: [] })).rejects.toBeInstanceOf(TransientError);
  });

  it.each([
    [429, TransientError],
    [503, TransientError],
    [401, LlmConfigurationError],
    [402, LlmConfigurationError],
    [404, LlmConfigurationError],
  ])('maps HTTP %d to %p', async (status, errorClass) => {
    const error = OpenAI.APIError.generate(status, { message: 'x' }, 'x', new Headers());
    const client = clientWith(jest.fn().mockRejectedValue(error));
    await expect(client.chat({ stage: 'plan', repairAttempt: 0, messages: [] })).rejects.toBeInstanceOf(errorClass);
  });
});
