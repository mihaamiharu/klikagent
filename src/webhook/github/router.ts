import { TriggerContext, ReviewContext } from '../../types';
import { log } from '../../utils/logger';
import { orchestrate } from '../../orchestrator';
import { runReviewAgent } from '../../agents/reviewAgent';
import { getReviewComments } from '../../services/github';

function isTriggerContext(result: TriggerContext | ReviewContext): result is TriggerContext {
  return 'flow' in result;
}

export async function routeGitHubEvent(result: TriggerContext | ReviewContext): Promise<void> {
  try {
    if (isTriggerContext(result)) {
      log('ROUTE', `GitHub TriggerContext → orchestrator (${result.ticketId}, status: ${result.status})`);
      await orchestrate(result);
    } else {
      log('ROUTE', `GitHub ReviewContext → Review Agent (${result.ticketId}, PR #${result.prNumber})`);
      const inlineComments = await getReviewComments(result.prNumber, result.reviewId, result.repo).catch(() => []);
      const enriched = { ...result, comments: inlineComments.length > 0 ? inlineComments : result.comments };
      const feature = result.branch.match(/^qa\/\d+-([^-]+)/)?.[1] ?? 'general';
      await runReviewAgent(enriched, feature);
    }
  } catch (err) {
    log('ERROR', `Error routing GitHub event: ${(err as Error).message}`);
  }
}
