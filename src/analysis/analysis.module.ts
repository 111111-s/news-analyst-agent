import { Module } from '@nestjs/common';
import { ClusteringService } from './clustering.service';
import { ExtractiveReportBuilder } from './extractive-report.builder';
import { SentimentService } from './sentiment.service';

@Module({
  providers: [SentimentService, ClusteringService, ExtractiveReportBuilder],
  exports: [SentimentService, ClusteringService, ExtractiveReportBuilder],
})
export class AnalysisModule {}
