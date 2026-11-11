import OpenAI from 'openai';
import type { AppConfig } from '../config/app-config';
import { TransientError } from '../common/retry';
import { ChatRequest, ChatResponse, LlmClient, LlmConfigurationError } from './llm.types';

type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  /** OpenRouter unified reasoning control (passed through by the SDK as-is). */
  reasoning?: { effort: string };
};

/**
 * OpenAI models through OpenRouter (https://openrouter.ai), using the official `openai` SDK with a
 * custom baseURL. SDK-level retries are disabled: the agent owns retries so they show up in traces.
 */
export class OpenRouterLlmClient implements LlmClient {
  readonly provider = 'openrouter';
  private readonly client: OpenAI;

  constructor(
    private readonly config: AppConfig,
    client?: OpenAI,
  ) {
    this.client =
      client ??
      new OpenAI({
        apiKey: config.openRouterApiKey,
        baseURL: config.openRouterBaseUrl,
        timeout: config.llmTimeoutMs,
        maxRetries: 0,
        defaultHeaders: { 'X-Title': 'News Analyst Agent' },
      });
  }

  get model(): string {
    return this.config.llmModel;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: CreateParams = {
      model: this.config.llmModel,
      messages: request.messages,
      max_tokens: this.config.llmMaxTokens,
    };
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }
    if (request.responseFormat) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true },
      };
    }
    if (this.config.llmTemperature !== undefined) body.temperature = this.config.llmTemperature;
    if (this.config.llmReasoningEffort) body.reasoning = { effort: this.config.llmReasoningEffort };

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(body);
    } catch (error) {
      throw this.mapError(error);
    }

    // OpenRouter can return HTTP 200 with an error object and no choices when an upstream provider fails.
    const choice = completion.choices?.[0];
    if (!choice) throw new TransientError('LLM response contained no choices (upstream provider error)');

    const toolCalls = (choice.message.tool_calls ?? [])
      .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
      .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '{}' }));

    return {
      content: choice.message.content ?? null,
      toolCalls,
      finishReason: choice.finish_reason ?? 'unknown',
      refusal: choice.message.refusal ?? null,
      model: completion.model ?? this.config.llmModel,
      usage: {
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  private mapError(error: unknown): Error {
    if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
      return new LlmConfigurationError(`OpenRouter rejected the credentials (${error.status}). Check OPENROUTER_API_KEY.`);
    }
    if (error instanceof OpenAI.NotFoundError) {
      return new LlmConfigurationError(`Model "${this.config.llmModel}" was not found on OpenRouter. Check LLM_MODEL.`);
    }
    if (error instanceof OpenAI.RateLimitError) return new TransientError('OpenRouter rate limit (429)', error);
    if (error instanceof OpenAI.APIConnectionError) return new TransientError(`OpenRouter connection error: ${error.message}`, error);
    if (error instanceof OpenAI.APIError) {
      const status = error.status ?? 0;
      if (status === 402) return new LlmConfigurationError('OpenRouter account has insufficient credits (402).');
      if (status === 408 || status === 409 || status >= 500) return new TransientError(`OpenRouter error ${status}`, error);
      return new Error(`OpenRouter request failed (${status}): ${error.message}`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
