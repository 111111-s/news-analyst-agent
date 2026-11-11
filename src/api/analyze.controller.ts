import { Body, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { AgentResult } from '../agent/agent-result';
import { NewsAgentService } from '../agent/news-agent.service';
import { PROMPT_VERSION } from '../agent/prompts';
import { RunStore } from '../agent/run-store.service';
import { AnalyzeRequestInput, AnalyzeRequestSchema } from '../agent/schemas';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { LLM_CLIENT, LlmClient } from '../llm/llm.types';
import { TraceEvent } from '../tracing/run-tracer';
import { ApiKeyGuard } from './api-key.guard';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller()
@UseGuards(ApiKeyGuard)
export class AnalyzeController {
  constructor(
    private readonly agent: NewsAgentService,
    private readonly runs: RunStore,
  ) {}

  /** Runs the agent synchronously. Business outcomes (refused, insufficient_data, ...) are 200 with a status field. */
  @Post('analyze')
  @HttpCode(200)
  analyze(@Body(new ZodValidationPipe(AnalyzeRequestSchema)) body: AnalyzeRequestInput): Promise<AgentResult> {
    return this.agent.run(body);
  }

  @Get('runs/:id')
  async getRun(@Param('id') id: string): Promise<AgentResult> {
    const result = await this.runs.getResult(id);
    if (!result) throw new NotFoundException(`Run ${id} not found`);
    return result;
  }

  @Get('runs/:id/summary')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async getSummary(@Param('id') id: string): Promise<string> {
    return (await this.getRun(id)).summaryMarkdown;
  }

  @Get('runs/:id/trace')
  async getTrace(@Param('id') id: string): Promise<TraceEvent[]> {
    const trace = await this.runs.getTrace(id);
    if (!trace) throw new NotFoundException(`Trace for run ${id} not found`);
    return trace;
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  health() {
    return {
      status: 'ok',
      llm: { provider: this.llm.provider, model: this.llm.model },
      newsProvider: this.config.newsProvider,
      promptVersion: PROMPT_VERSION,
    };
  }
}
