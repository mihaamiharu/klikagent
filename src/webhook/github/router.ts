import { TriggerContext, ReviewContext } from '../../types';
import { log } from '../../utils/logger';
import { flow3 } from '../../flows/flow3';
import { runReviewAgent } from '../../agents/reviewAgent';

function isTriggerContext(result: TriggerContext | ReviewContext): result is TriggerContext {
  return 'flow' in result;
}

export async function routeGitHubEvent(result: TriggerContext | ReviewContext): Promise<void> {
  try {
    if (isTriggerContext(result)) {
      log('ROUTE', `GitHub TriggerContext → Flow 3 (${result.ticketId}, runType: ${result.runType}, runId: ${result.runId})`);
      await flow3(result);
    } else {
      log('ROUTE', `GitHub ReviewContext → Review Agent (${result.ticketId}, PR #${result.prNumber})`);
      await runReviewAgent(result, 'general');
    }
  } catch (err) {
    log('ERROR', `Error routing GitHub event: ${(err as Error).message}`);
  }
}
