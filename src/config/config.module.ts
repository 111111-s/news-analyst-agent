import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './app-config';

export const CLOCK = Symbol('CLOCK');

/** Injectable clock so default date ranges are deterministic in tests. */
export interface Clock {
  now(): Date;
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
  ],
  exports: [APP_CONFIG, CLOCK],
})
export class ConfigModule {}
