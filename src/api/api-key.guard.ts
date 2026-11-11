import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/** Optional bearer-token auth. Disabled when API_AUTH_TOKEN is not set (local development). */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.apiAuthToken;
    if (!expected) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    const provided = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
    if (typeof provided === 'string' && safeEqual(provided, expected)) return true;
    throw new UnauthorizedException('Missing or invalid API token');
  }
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
