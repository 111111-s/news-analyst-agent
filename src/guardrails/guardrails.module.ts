import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { InjectionDetector } from './injection-detector';
import { InputGuard } from './input-guard';
import { ReportValidator } from './report-validator';

@Module({
  imports: [AnalysisModule],
  providers: [InjectionDetector, InputGuard, ReportValidator],
  exports: [InjectionDetector, InputGuard, ReportValidator],
})
export class GuardrailsModule {}
