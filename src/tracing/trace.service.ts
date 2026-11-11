import { Injectable, Logger } from '@nestjs/common';
import { RunTracer } from './run-tracer';

@Injectable()
export class TraceService {
  private readonly logger = new Logger('Trace');

  start(runId: string): RunTracer {
    return new RunTracer(runId, this.logger);
  }
}
