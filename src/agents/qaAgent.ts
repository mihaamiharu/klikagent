import { QATask } from '../types';
import { TokenUsage } from '../services/ai';
import { runExplorerAgent } from './explorerAgent';
import { runWriterAgent } from './writerAgent';
import { prefetchBaseContext, resolveWriterContext } from '../services/writerContext';

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
  // Step 1: Explore + base context fetch run in parallel.
  // Base context (fixtures, personas, contextDocs, POMs list) is feature-independent
  // so we overlap it with the long browser exploration phase.
  const [{ report, tokenUsage: explorerUsage }, baseCtx] = await Promise.all([
    runExplorerAgent(task, branch, repoName),
    prefetchBaseContext(repoName),
  ]);

  // Step 2: Fetch the feature-specific context now that we know the feature name.
  const ctx = await resolveWriterContext(repoName, report.feature, baseCtx);

  // Step 3: Write — fresh-context agent generates spec + POM from the report, no browser access.
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
