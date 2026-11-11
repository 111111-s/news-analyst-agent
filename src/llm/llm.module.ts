import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { ExtractiveReportBuilder } from '../analysis/extractive-report.builder';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { LLM_CLIENT, LlmClient } from './llm.types';
import { OfflineLlmClient } from './offline-llm.client';
import { OpenRouterLlmClient } from './openrouter-llm.client';

@Module({
  imports: [AnalysisModule],
  providers: [
    {
      provide: LLM_CLIENT,
      inject: [APP_CONFIG, ExtractiveReportBuilder],
      useFactory: (config: AppConfig, builder: ExtractiveReportBuilder): LlmClient =>
        config.llmProvider === 'openrouter' ? new OpenRouterLlmClient(config) : new OfflineLlmClient(builder),
    },
  ],
  exports: [LLM_CLIENT],
})
export class LlmModule {}
