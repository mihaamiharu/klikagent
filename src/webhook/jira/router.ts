import { TriggerContext } from '../../types';
import { log } from '../../utils/logger';
import { orchestrate } from '../../orchestrator';

export async function routeToFlow(context: TriggerContext): Promise<void> {
  log('ROUTE', `${context.ticketId} → orchestrator (${context.status}, scope:${context.scope}, isRework: ${context.isRework})`);

  try {
    await orchestrate(context);
  } catch (err) {
    log('ERROR', `Error in orchestrator for ${context.ticketId}: ${(err as Error).message}`);
  }
}
