import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AnalyzeController, HealthController } from './analyze.controller';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  imports: [AgentModule],
  controllers: [AnalyzeController, HealthController],
  providers: [ApiKeyGuard],
})
export class ApiModule {}
