import { Test, TestingModule } from '@nestjs/testing';
import { NewsAgentService } from '../../src/agent/news-agent.service';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, AppConfig } from '../../src/config/app-config';
import { CLOCK } from '../../src/config/config.module';
import { LLM_CLIENT, LlmClient } from '../../src/llm/llm.types';
import { testConfig } from './test-config';

export const FIXED_NOW = new Date('2026-11-11T12:00:00Z');

export async function createTestingModule(config: Partial<AppConfig> = {}, llm?: LlmClient): Promise<TestingModule> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig(config))
    .overrideProvider(CLOCK)
    .useValue({ now: () => FIXED_NOW });
  if (llm) builder = builder.overrideProvider(LLM_CLIENT).useValue(llm);
  const moduleRef = await builder.compile();
  if (!process.env.TEST_LOGS) moduleRef.useLogger(false); // expected failures would otherwise spam the output
  return moduleRef;
}

export async function createAgent(config: Partial<AppConfig> = {}, llm?: LlmClient): Promise<NewsAgentService> {
  const moduleRef = await createTestingModule(config, llm);
  return moduleRef.get(NewsAgentService);
}
