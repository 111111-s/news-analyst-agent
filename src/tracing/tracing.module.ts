import { Module } from '@nestjs/common';
import { TraceService } from './trace.service';

@Module({
  providers: [TraceService],
  exports: [TraceService],
})
export class TracingModule {}
