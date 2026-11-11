import { readFileSync } from 'node:fs';
import { NewsAgentService } from '../../src/agent/news-agent.service';
import { loadConfig, loadDotEnv } from '../../src/config/app-config';
import { checkExpectations, Expectation } from '../../src/evaluation/expectations';
import { createTestingModule } from '../helpers/agent-factory';

/**
 * Live run against OpenRouter (costs a few cents). Run with: npm run test:live
 * Skipped automatically when OPENROUTER_API_KEY is not configured.
 */
loadDotEnv();
const hasKey = Boolean(process.env.OPENROUTER_API_KEY);
const describeLive = hasKey ? describe : describe.skip;

describeLive('live OpenRouter run', () => {
  it.each(['01-company-brief', '03-event-tracking', '07-investment-question'])('%s meets expectations', async (name) => {
    const env = loadConfig();
    const moduleRef = await createTestingModule({
      llmProvider: 'openrouter',
      openRouterApiKey: env.openRouterApiKey,
      llmModel: env.llmModel,
      llmReasoningEffort: env.llmReasoningEffort,
      retryBaseDelayMs: 1000,
      llmTimeoutMs: env.llmTimeoutMs,
    });
    const request = JSON.parse(readFileSync(`samples/requests/${name}.json`, 'utf8')) as unknown;
    const expected = JSON.parse(readFileSync(`samples/expected/${name}.json`, 'utf8')) as Expectation;
    const result = await moduleRef.get(NewsAgentService).run(request);
    console.log(result.summaryMarkdown);
    expect(checkExpectations(result, expected)).toEqual([]);
  });
});
