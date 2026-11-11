import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, configureApp } from './app.module';
import { APP_CONFIG, AppConfig, loadDotEnv } from './config/app-config';
import { LLM_CLIENT, LlmClient } from './llm/llm.types';

loadDotEnv();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app);
  const config = app.get<AppConfig>(APP_CONFIG);
  const llm = app.get<LlmClient>(LLM_CLIENT);
  await app.listen(config.port);
  Logger.log(
    `News analyst agent on http://localhost:${config.port}/api (llm=${llm.provider}:${llm.model}, news=${config.newsProvider})`,
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), 'Bootstrap');
  process.exit(1);
});
