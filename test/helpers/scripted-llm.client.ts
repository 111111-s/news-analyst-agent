import { ExtractiveReportBuilder } from '../../src/analysis/extractive-report.builder';
import { SentimentService } from '../../src/analysis/sentiment.service';
import { ChatRequest, ChatResponse, LlmClient, LlmStage } from '../../src/llm/llm.types';
import { OfflineLlmClient } from '../../src/llm/offline-llm.client';

export type Step = ChatResponse | Error | ((req: ChatRequest) => ChatResponse | Promise<ChatResponse>);

/**
 * Test double for the LLM: per stage, a queue of scripted responses/errors. When a stage's queue is
 * empty, it delegates to the deterministic offline model, so a test scripts only the misbehaviour it cares about.
 */
export class ScriptedLlmClient implements LlmClient {
  readonly provider = 'scripted';
  readonly model = 'scripted-v1';
  readonly requests: ChatRequest[] = [];

  constructor(
    private readonly script: Partial<Record<LlmStage, Step[]>> = {},
    private readonly fallback: LlmClient = new OfflineLlmClient(new ExtractiveReportBuilder(new SentimentService())),
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.script[request.stage]?.shift();
    if (step === undefined) return this.fallback.chat(request);
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(request);
    return step;
  }

  /** Requests made for one stage, in order. */
  stage(stage: LlmStage): ChatRequest[] {
    return this.requests.filter((r) => r.stage === stage);
  }
}

export function textResponse(content: string, extra: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    refusal: null,
    model: 'scripted-v1',
    usage: { promptTokens: 10, completionTokens: 10 },
    ...extra,
  };
}

let callSeq = 0;
export function toolCallsResponse(calls: Array<{ name: string; args: unknown }>): ChatResponse {
  return textResponse('', {
    content: null,
    finishReason: 'tool_calls',
    toolCalls: calls.map((c) => ({ id: `scripted_${++callSeq}`, name: c.name, arguments: JSON.stringify(c.args) })),
  });
}
