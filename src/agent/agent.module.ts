import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { LlmModule } from '../llm/llm.module';
import { ToolsModule } from '../tools/tools.module';
import { TracingModule } from '../tracing/tracing.module';
import { NewsAgentService } from './news-agent.service';
import { RunStore } from './run-store.service';

@Module({
  imports: [LlmModule, ToolsModule, GuardrailsModule, AnalysisModule, TracingModule],
  providers: [NewsAgentService, RunStore],
  exports: [NewsAgentService, RunStore, LlmModule],
})
export class AgentModule {}
