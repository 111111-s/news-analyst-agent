import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { NewsModule } from '../news/news.module';
import { NewsTools } from './news-tools';
import { ToolExecutor } from './tool-executor';

@Module({
  imports: [NewsModule, AnalysisModule, GuardrailsModule],
  providers: [NewsTools, ToolExecutor],
  exports: [ToolExecutor],
})
export class ToolsModule {}
