import { TriggerContext, ReviewContext } from '../../types';
import { log } from '../../utils/logger';
import { reviewAgent } from '../../agents/reviewAgent';

function isTriggerContext(result: TriggerContext | ReviewContext): result is TriggerContext {
  return 'flow' in result;
}

export async function routeGitHubEvent(result: TriggerContext | ReviewContext): Promise<void> {
  try {
    if (isTriggerContext(result)) {
      log('ROUTE', `GitHub TriggerContext → orchestrator (${result.ticketId}, status: ${result.status})`);
      // GitHub Actions workflow_run events are no longer routed via TriggerContext —
      // handled directly by the orchestrator via status label routing.
      log('SKIP', `[githubRouter] TriggerContext received — no handler (workflow_run removed from types)`);
    } else {
      log('ROUTE', `GitHub ReviewContext → Review Agent (${result.ticketId}, PR #${result.prNumber})`);
      await reviewAgent(result);
    }
  } catch (err) {
    log('ERROR', `Error routing GitHub event: ${(err as Error).message}`);
  }
}
