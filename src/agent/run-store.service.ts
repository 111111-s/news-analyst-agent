import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { errorMessage } from '../common/retry';
import type { TraceEvent } from '../tracing/run-tracer';
import type { AgentResult } from './agent-result';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMORY_LIMIT = 200;

/**
 * Keeps recent results in memory and persists results + traces to RUNS_DIR as files.
 * Production would use a database / object storage; the interface stays the same.
 */
@Injectable()
export class RunStore {
  private readonly logger = new Logger(RunStore.name);
  private readonly results = new Map<string, AgentResult>();
  private readonly traces = new Map<string, TraceEvent[]>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async save(result: AgentResult, trace: TraceEvent[]): Promise<void> {
    this.remember(this.results, result.runId, result);
    this.remember(this.traces, result.runId, trace);
    if (!this.config.runsDir) return;
    try {
      await mkdir(this.config.runsDir, { recursive: true });
      await writeFile(this.path(result.runId, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
      await writeFile(this.path(result.runId, 'trace.jsonl'), trace.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch (error) {
      // Persistence problems must never fail a run that already produced a result.
      this.logger.warn(`could not persist run ${result.runId}: ${errorMessage(error)}`);
    }
  }

  async getResult(runId: string): Promise<AgentResult | null> {
    if (!RUN_ID.test(runId)) return null; // also prevents path traversal
    return this.results.get(runId) ?? (await this.readJson<AgentResult>(runId, 'result.json'));
  }

  async getTrace(runId: string): Promise<TraceEvent[] | null> {
    if (!RUN_ID.test(runId)) return null;
    const cached = this.traces.get(runId);
    if (cached) return cached;
    if (!this.config.runsDir) return null;
    try {
      const text = await readFile(this.path(runId, 'trace.jsonl'), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TraceEvent);
    } catch {
      return null;
    }
  }

  private async readJson<T>(runId: string, suffix: string): Promise<T | null> {
    if (!this.config.runsDir) return null;
    try {
      return JSON.parse(await readFile(this.path(runId, suffix), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private path(runId: string, suffix: string): string {
    return join(this.config.runsDir, `${runId}.${suffix}`);
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    if (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value as string);
  }
}
