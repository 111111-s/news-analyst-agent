import { Injectable } from '@nestjs/common';
import { InjectionDetector } from './injection-detector';

export type RefusalCategory = 'disinformation' | 'impersonation' | 'privacy' | 'prompt_injection' | 'out_of_scope';

export interface InputGuardResult {
  action: 'allow' | 'refuse';
  category?: RefusalCategory;
  reason?: string;
  /** Non-blocking flags that change downstream behaviour, e.g. `investment_advice_request`. */
  flags: string[];
}

interface RefusalRule {
  category: RefusalCategory;
  pattern: RegExp;
  reason: string;
}

const REFUSAL_RULES: RefusalRule[] = [
  {
    category: 'disinformation',
    pattern:
      /\b(write|create|generate|draft|make up|fabricate|invent|produce)\b[^.?!]{0,60}\b(fake|false|fabricated|made[- ]up|hoax|fictitious)\b[^.?!]{0,30}\b(news|articles?|stor(y|ies)|headlines?|reports?|press releases?|quotes?)\b/i,
    reason: 'Creating fabricated news or quotes is not supported. The agent only analyses published coverage.',
  },
  {
    category: 'disinformation',
    pattern: /\b(spread|plant|seed)\b[^.?!]{0,30}\b(rumou?rs?|misinformation|disinformation|propaganda)\b/i,
    reason: 'Spreading rumours or disinformation is not supported.',
  },
  {
    category: 'impersonation',
    pattern: /\b(impersonat\w*|pretend(ing)? to be|posing as|in the name of)\b[^.?!]{0,40}\b(reuters|bbc|cnn|associated press|ap|bloomberg|journalists?|reporters?|newspapers?|outlets?)\b/i,
    reason: 'Impersonating news outlets or journalists is not supported.',
  },
  {
    category: 'privacy',
    pattern:
      /\b(home address|phone number|personal (email|address|phone)|where (does|do|did)\b[^.?!]{0,40}\blive|social security|passport number|date of birth|license plate)\b/i,
    reason: 'Collecting personal data about individuals is not supported.',
  },
  {
    category: 'out_of_scope',
    pattern: /\b(write|compose|generate)\b[^.?!]{0,30}\b(poem|song|lyrics|essay|code|program|homework)\b/i,
    reason: 'This agent only researches and analyses news coverage.',
  },
];

const INVESTMENT_ADVICE =
  /\b(should (i|we)|is it (a )?good (time|idea) to|worth (buying|selling))\b[^.?!]{0,50}\b(buy|sell|invest|short|hold|stocks?|shares?)\b|\b(price target|stock tips?|which stocks?)\b/i;

/** Deterministic pre-LLM screening of the analyst's request. Runs before any model call. */
@Injectable()
export class InputGuard {
  constructor(private readonly injection: InjectionDetector) {}

  check(query: string): InputGuardResult {
    const scan = this.injection.scan(query);
    if (scan.suspected) {
      return {
        action: 'refuse',
        category: 'prompt_injection',
        reason: `The request contains instructions aimed at the agent itself (${scan.findings.map((f) => f.rule).join(', ')}).`,
        flags: ['prompt_injection_in_query'],
      };
    }
    for (const rule of REFUSAL_RULES) {
      if (rule.pattern.test(query)) return { action: 'refuse', category: rule.category, reason: rule.reason, flags: [] };
    }
    const flags = INVESTMENT_ADVICE.test(query) ? ['investment_advice_request'] : [];
    return { action: 'allow', flags };
  }
}
