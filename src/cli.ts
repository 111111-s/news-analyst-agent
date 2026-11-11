import 'reflect-metadata';
import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { NewsAgentService } from './agent/news-agent.service';
import { AppModule } from './app.module';
import { loadDotEnv } from './config/app-config';

const USAGE = `Usage:
  node dist/cli.js "<query>" [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--max N] [--lang en] [--json] [--out result.json] [--verbose]
  node dist/cli.js --file samples/requests/01-company-brief.json [--json] [--verbose]

Examples:
  node dist/cli.js "What is happening with Northwind Robotics?" --from 2026-10-01 --to 2026-11-10 --max 10
  LLM_PROVIDER=offline node dist/cli.js --file samples/requests/03-event-tracking.json`;

interface CliArgs {
  request: Record<string, unknown>;
  json: boolean;
  verbose: boolean;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { request: {}, json: false, verbose: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--from':
        args.request.from = next();
        break;
      case '--to':
        args.request.to = next();
        break;
      case '--max':
        args.request.maxArticles = Number(next());
        break;
      case '--lang':
        args.request.language = next();
        break;
      case '--file':
        args.request = { ...JSON.parse(readFileSync(next(), 'utf8')), ...args.request };
        break;
      case '--out':
        args.out = next();
        break;
      case '--json':
        args.json = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        positional.push(a);
    }
  }
  if (positional.length) args.request.query = positional.join(' ');
  if (args.request.query === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  return args;
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const logger: LogLevel[] = args.verbose ? ['log', 'warn', 'error', 'debug'] : ['error'];
  const app = await NestFactory.createApplicationContext(AppModule, { logger });
  try {
    const result = await app.get(NewsAgentService).run(args.request);
    if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8');
    process.stdout.write(args.json ? JSON.stringify(result, null, 2) + '\n' : result.summaryMarkdown);
    if (!args.json) process.stderr.write(`\nstatus=${result.status} run=${result.runId}${args.out ? ` saved=${args.out}` : ''}\n`);
    process.exitCode = result.status === 'failed' ? 1 : result.status === 'invalid_input' ? 2 : 0;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
