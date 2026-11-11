import type OpenAI from 'openai';

export const LLM_CLIENT = Symbol('LLM_CLIENT');

/** OpenRouter speaks the OpenAI Chat Completions protocol, so we reuse the SDK's message/tool types. */
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionFunctionTool;

export type LlmStage = 'plan' | 'research' | 'analyze';

export interface ChatRequest {
  stage: LlmStage;
  /** 0 for the first attempt; 1+ for repair attempts after a validation failure. */
  repairAttempt: number;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Ask for JSON that matches this (strict) JSON schema. */
  responseFormat?: { name: string; schema: Record<string, unknown> };
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string produced by the model - validated by the tool executor before use. */
  arguments: string;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string;
  /** Model-side refusal message (OpenAI `message.refusal`), if any. */
  refusal: string | null;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** Non-retryable: bad key, no credits, unknown model. The run fails fast with a clear message. */
export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigurationError';
  }
}

export function assistantMessage(res: ChatResponse): ChatMessage {
  return {
    role: 'assistant',
    content: res.content ?? null,
    ...(res.toolCalls.length
      ? {
          tool_calls: res.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : {}),
  };
}

export function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}
