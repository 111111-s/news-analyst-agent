import { Injectable } from '@nestjs/common';
import { INJECTION_PLACEHOLDER } from '../analysis/extractive-report.builder';
import { splitSentences, truncate } from '../common/text';

interface Rule {
  id: string;
  weight: number;
  pattern: RegExp;
}

/**
 * Heuristic detector for instructions aimed at the model inside untrusted text (news articles,
 * snippets, user queries). It is one layer of defence; the others are structural: read-only tools,
 * no tool can widen its own scope, citations are verified in code, and the final report is validated.
 */
const RULES: Rule[] = [
  {
    id: 'override_instructions',
    weight: 3,
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|any|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directives|guidelines)\b/i,
  },
  {
    id: 'prompt_exfiltration',
    weight: 3,
    pattern: /\b(reveal|print|show|repeat|output|leak|display)\b[^.\n]{0,30}\b(system prompt|hidden instructions|your instructions|developer message|your prompt)\b/i,
  },
  {
    id: 'addressed_to_ai',
    weight: 2,
    pattern: /\b(note|message|attention|instructions?|reminder)\s+(to|for)\s+(ai|llms?|chatbots?|assistants?|language models?|ai (systems?|models?|agents?|assistants?))\b/i,
  },
  { id: 'role_hijack', weight: 2, pattern: /\b(you are now|from now on,? you|act as (an? )?(ai|assistant|chatbot|language model|dan))\b/i },
  { id: 'fake_role_tag', weight: 2, pattern: /<\/?\s*(system|assistant|developer|instructions?|tool_call)\s*>|^\s*(system|assistant|developer)\s*:/im },
  { id: 'jailbreak_terms', weight: 2, pattern: /\b(jailbreak|dan mode|developer mode|do anything now)\b/i },
  {
    id: 'tool_manipulation',
    weight: 1,
    pattern: /\b(call|invoke|execute|run)\b[^.\n]{0,20}\b(search_news|fetch_article|cluster_stories|analyze_sentiment|the (function|tool))\b/i,
  },
];

const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤﻿]/g;
const SUSPICION_THRESHOLD = 2;

export interface InjectionFinding {
  rule: string;
  excerpt: string;
}

export interface InjectionScan {
  suspected: boolean;
  score: number;
  findings: InjectionFinding[];
  /** Text with hidden characters stripped and offending sentences replaced by a placeholder. */
  sanitized: string;
}

@Injectable()
export class InjectionDetector {
  scan(text: string): InjectionScan {
    const hidden = (text.match(HIDDEN_CHARS) ?? []).length;
    const clean = text.replace(HIDDEN_CHARS, '');
    const findings: InjectionFinding[] = [];
    let score = hidden > 0 ? 1 : 0;
    if (hidden > 0) findings.push({ rule: 'hidden_characters', excerpt: `${hidden} invisible character(s)` });

    const flaggedSentences = new Set<string>();
    for (const sentence of splitSentences(clean)) {
      for (const rule of RULES) {
        const match = rule.pattern.exec(sentence);
        if (!match) continue;
        score += rule.weight;
        findings.push({ rule: rule.id, excerpt: truncate(match[0], 120) });
        if (rule.weight >= 2) flaggedSentences.add(sentence);
      }
    }
    const suspected = score >= SUSPICION_THRESHOLD;
    let sanitized = clean;
    if (suspected) {
      for (const sentence of flaggedSentences) sanitized = sanitized.split(sentence).join(INJECTION_PLACEHOLDER);
    }
    return { suspected, score, findings, sanitized };
  }
}
