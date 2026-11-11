import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { Credibility } from './news.types';

interface SourceEntry {
  outlet: string;
  domain: string;
  credibility: Credibility;
}

/**
 * Static outlet credibility list (data/sources.json). In production this would be an editorial
 * allow/deny list maintained by the team; here it drives confidence calibration of claims.
 */
@Injectable()
export class SourceCredibilityService {
  private readonly byOutlet = new Map<string, Credibility>();
  private readonly byDomain = new Map<string, Credibility>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const entries = JSON.parse(readFileSync(config.newsSourcesPath, 'utf8')) as SourceEntry[];
    for (const e of entries) {
      this.byOutlet.set(e.outlet.toLowerCase(), e.credibility);
      this.byDomain.set(e.domain.toLowerCase(), e.credibility);
    }
  }

  lookup(outlet: string, url?: string): Credibility {
    const byName = this.byOutlet.get(outlet.trim().toLowerCase());
    if (byName) return byName;
    if (url) {
      try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        for (const [domain, cred] of this.byDomain) {
          if (host === domain || host.endsWith('.' + domain)) return cred;
        }
      } catch {
        /* invalid URL */
      }
    }
    return 'unknown';
  }
}
