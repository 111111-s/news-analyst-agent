import type { LoggerService } from '@nestjs/common';

export interface TraceEvent {
  seq: number;
  ts: string;
  runId: string;
  type: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

/** Credential-like keys. Deliberately does not match usage counters such as `tokens` / `promptTokens`. */
const SECRET_KEY = /(api[-_]?key|(access|auth|bearer|refresh|id|session)[-_]?token|^token$|authorization|secret|password|cookie)/i;
const MAX_STRING = 600;
const MAX_ARRAY = 25;

/**
 * Append-only event log for one agent run. Every LLM call, tool call, retry, guardrail decision and
 * validation outcome becomes one event; the log is streamed to the logger and persisted as JSONL.
 */
export class RunTracer {
  private readonly events: TraceEvent[] = [];

  constructor(
    readonly runId: string,
    private readonly logger?: LoggerService,
  ) {}

  event(type: string, data?: Record<string, unknown>, durationMs?: number): void {
    const event: TraceEvent = {
      seq: this.events.length + 1,
      ts: new Date().toISOString(),
      runId: this.runId,
      type,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(data ? { data: redact(data) as Record<string, unknown> } : {}),
    };
    this.events.push(event);
    if (this.logger) {
      const line = JSON.stringify(event);
      if (type.endsWith('.error') || type === 'report.fallback') this.logger.warn?.(line);
      else if (type === 'run.start' || type === 'run.end') this.logger.log(line);
      else this.logger.debug?.(line);
    }
  }

  getEvents(): TraceEvent[] {
    return [...this.events];
  }
}

/** Truncate long strings/arrays and blank anything that looks like a credential. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `… ${value.length - MAX_ARRAY} more`] : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
