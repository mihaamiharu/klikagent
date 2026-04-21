import { TriggerContext, ReviewContext } from '../../types';
import { log } from '../../utils/logger';
import { flow2 } from '../../orchestrator';
import { runReviewAgent } from '../../agents/reviewAgent';
import { getReviewComments } from '../../services/github';

function isTriggerContext(result: TriggerContext | ReviewContext): result is TriggerContext {
  return 'flow' in result;
}

export async function routeGitHubEvent(result: TriggerContext | ReviewContext): Promise<void> {
  try {
    if (isTriggerContext(result)) {
      log('ROUTE', `GitHub TriggerContext → Flow ${result.flow} (${result.ticketId})`);
      if (result.flow === 2) {
        await flow2(result);
      } else {
        log('INFO', `Flow ${result.flow} is a no-op — skipping`);
      }
    } else {
      log('ROUTE', `GitHub ReviewContext → Review Agent (${result.ticketId}, PR #${result.prNumber})`);
      // Fetch real inline comments (supplement synthetic review body comment)
      const inlineComments = await getReviewComments(result.prNumber, result.reviewId, result.repo).catch(() => []);
      const enriched = { ...result, comments: inlineComments.length > 0 ? inlineComments : result.comments };
      // Derive feature from branch name e.g. "qa/42-login-validation" → "login"
      const feature = result.branch.match(/^qa\/\d+-([^-]+)/)?.[1] ?? 'general';
      await runReviewAgent(enriched, feature);
    }
  } catch (err) {
    log('ERROR', `Error routing GitHub event: ${(err as Error).message}`);
  }
}
