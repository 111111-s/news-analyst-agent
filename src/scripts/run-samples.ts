import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { NewsAgentService } from '../agent/news-agent.service';
import { AppModule } from '../app.module';
import { loadDotEnv } from '../config/app-config';
import { checkExpectations, Expectation } from '../evaluation/expectations';
import { LLM_CLIENT, LlmClient } from '../llm/llm.types';

/**
 * Runs every request in samples/requests, writes JSON + Markdown outputs to samples/outputs/<provider>/
 * and checks them against samples/expected. Works offline (deterministic) and with a live LLM,
 * so it doubles as a small regression/eval harness for prompt or model changes.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const only = process.argv[2];
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const agent = app.get(NewsAgentService);
  const llm = app.get<LlmClient>(LLM_CLIENT);
  const outDir = join('samples', 'outputs', llm.provider);
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(join('samples', 'requests'))
    .filter((f) => f.endsWith('.json') && (!only || f.includes(only)))
    .sort();
  let failed = 0;
  console.log(`Running ${files.length} sample(s) with ${llm.provider}:${llm.model}\n`);

  for (const file of files) {
    const name = basename(file, '.json');
    const request = JSON.parse(readFileSync(join('samples', 'requests', file), 'utf8')) as unknown;
    const expected = JSON.parse(readFileSync(join('samples', 'expected', file), 'utf8')) as Expectation;
    const result = await agent.run(request);
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 2), 'utf8');
    writeFileSync(join(outDir, `${name}.md`), result.summaryMarkdown, 'utf8');

    const failures = checkExpectations(result, expected);
    if (failures.length) failed++;
    const m = result.metrics;
    console.log(
      `${failures.length ? 'FAIL' : 'PASS'}  ${name.padEnd(28)} status=${result.status.padEnd(17)} ` +
        `llm=${m.llmCalls} tools=${m.toolCalls} retries=${m.retries} fixes=${result.guardrails.corrections.length} ${(m.durationMs / 1000).toFixed(1)}s`,
    );
    for (const f of failures) console.log(`      - ${f}`);
  }
  await app.close();
  console.log(`\n${files.length - failed}/${files.length} passed. Outputs: ${outDir}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
