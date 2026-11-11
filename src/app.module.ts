import { INestApplication, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AgentModule } from './agent/agent.module';
import { ApiModule } from './api/api.module';
import { ConfigModule } from './config/config.module';

@Module({
  imports: [ConfigModule, AgentModule, ApiModule],
})
export class AppModule {}

/** Shared HTTP setup for main.ts and e2e tests. */
export function configureApp(app: INestApplication): INestApplication {
  const express = app as NestExpressApplication;
  express.useBodyParser('json', { limit: '32kb' });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
