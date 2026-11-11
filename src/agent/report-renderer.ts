import type { AgentResult } from './agent-result';

/** Deterministic Markdown rendering of a result - the human-readable counterpart of the JSON. */
export function renderMarkdown(result: AgentResult): string {
  const lines: string[] = [];
  const r = result.report;
  const req = result.request;

  lines.push(`# ${r?.headline ?? titleFor(result)}`, '');
  lines.push(
    [
      `**Status:** ${result.status}`,
      req ? `**Period:** ${req.from} → ${req.to}` : null,
      `**Sources:** ${result.sources.length} article(s) from ${new Set(result.sources.map((s) => s.outlet)).size} outlet(s)`,
      `**Run:** \`${result.runId}\``,
    ]
      .filter(Boolean)
      .join(' · '),
    '',
  );
  if (req) lines.push(`> ${req.query}`, '');

  if (result.guardrails.refusal) {
    lines.push('## Request declined', '', `${result.guardrails.refusal.reason} _(category: ${result.guardrails.refusal.category})_`, '');
  }
  if (result.errors.length) {
    lines.push('## Errors', '', ...result.errors.map((e) => `- \`${e.code}\`: ${e.message}`), '');
  }
  for (const d of result.guardrails.disclaimers) lines.push(`> ⚠️ ${d}`, '');

  if (r) {
    lines.push('## Executive summary', '', r.executiveSummary, '');
    if (r.keyDevelopments.length) {
      lines.push('## Key developments', '');
      r.keyDevelopments.forEach((d, i) => {
        lines.push(`${i + 1}. **${d.date} — ${d.title}** _(confidence: ${d.confidence})_  `, `   ${d.summary} ${cite(d.articleIds)}`);
      });
      lines.push('');
    }
    if (r.entitySentiment.length) {
      lines.push('## Sentiment by entity', '', '| Entity | Sentiment | Score | Basis |', '|---|---|---|---|');
      for (const e of r.entitySentiment) lines.push(`| ${e.entity} | ${e.label} | ${e.score.toFixed(2)} | ${e.rationale} ${cite(e.articleIds)} |`);
      lines.push('');
    }
    if (r.risks.length) lines.push('## Risks', '', ...r.risks.map((x) => `- ${x.description} ${cite(x.articleIds)}`), '');
    if (r.opportunities.length) lines.push('## Opportunities', '', ...r.opportunities.map((x) => `- ${x.description} ${cite(x.articleIds)}`), '');
    if (r.openQuestions.length) lines.push('## Open questions', '', ...r.openQuestions.map((q) => `- ${q}`), '');
    if (r.coverageNotes) lines.push('## Coverage notes', '', r.coverageNotes, '');
  }

  if (result.sources.length) {
    lines.push('## Sources', '');
    for (const s of result.sources) {
      const flags = s.flags.length ? ` ⚠️ ${s.flags.join(', ')}` : '';
      lines.push(`- \`${s.id}\` [${s.title}](${s.url}) — ${s.outlet} (${s.credibility}), ${s.publishedAt.slice(0, 10)}${flags}`);
    }
    lines.push('');
  }

  const g = result.guardrails;
  const guardLines = [
    g.inputFlags.length ? `- Input flags: ${g.inputFlags.join(', ')}` : null,
    g.injectionFindings.length
      ? `- Prompt-injection text removed from: ${g.injectionFindings.map((f) => `${f.articleId} (${f.rules.join(', ')})`).join('; ')}`
      : null,
    ...g.corrections.map((c) => `- Corrected \`${c.path}\` (${c.rule}): ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`),
    g.usedFallback ? '- LLM synthesis failed validation; deterministic extractive report used instead.' : null,
    ...g.validationErrors.map((e) => `- Validation: ${e}`),
  ].filter((l): l is string => !!l);
  if (guardLines.length) lines.push('## Guardrails', '', ...guardLines, '');

  const m = result.metrics;
  lines.push(
    '---',
    `_${result.llm.provider}:${result.llm.model} · prompts ${result.promptVersion} · ${m.llmCalls} LLM call(s), ${m.toolCalls} tool call(s), ${m.retries} retr${m.retries === 1 ? 'y' : 'ies'}, ${m.promptTokens + m.completionTokens} tokens, ${(m.durationMs / 1000).toFixed(1)}s_`,
  );
  return lines.join('\n') + '\n';
}

function cite(ids: string[]): string {
  return ids.length ? `[${ids.join(', ')}]` : '';
}

function titleFor(result: AgentResult): string {
  switch (result.status) {
    case 'refused':
      return 'Request declined';
    case 'invalid_input':
      return 'Invalid request';
    case 'failed':
      return 'Run failed';
    default:
      return 'News analysis';
  }
}
