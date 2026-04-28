import { QATask } from '../types';
import { TokenUsage } from '../services/ai';
import { runExplorerAgent } from './explorerAgent';
import { runWriterAgent } from './writerAgent';
import { prefetchWriterContext } from '../services/writerContext';

export async function runQaAgent(
  task: QATask,
  branch: string,
  repoName: string,
): Promise<{
  feature: string;
  enrichedSpec: string;
  poms: Array<{ pomContent: string; pomPath: string }>;
  affectedPaths: string;
  fixtureUpdate?: string;
  tokenUsage: TokenUsage;
}> {
  // Step 1: Explore — browser agent navigates the live app and produces a structured report
  const { report, tokenUsage: explorerUsage } = await runExplorerAgent(task, branch, repoName);

  // Step 2: Pre-fetch repo context so the writer starts with a fully self-contained message
  const ctx = await prefetchWriterContext(repoName, report.feature);

  // Step 3: Write — fresh-context agent generates spec + POM from the report, no browser access
  const { feature, enrichedSpec, poms, affectedPaths, fixtureUpdate, tokenUsage: writerUsage } =
    await runWriterAgent(task, branch, report, ctx);

  return {
    feature,
    enrichedSpec,
    poms,
    affectedPaths,
    fixtureUpdate,
    tokenUsage: {
      promptTokens:     explorerUsage.promptTokens     + writerUsage.promptTokens,
      completionTokens: explorerUsage.completionTokens + writerUsage.completionTokens,
      totalTokens:      explorerUsage.totalTokens      + writerUsage.totalTokens,
      costUSD:          explorerUsage.costUSD           + writerUsage.costUSD,
    },
  };
}
