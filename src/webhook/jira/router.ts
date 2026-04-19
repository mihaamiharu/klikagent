import { TriggerContext } from '../../types';
import { log } from '../../utils/logger';
import { flow1, flow2, flow3 } from '../../orchestrator';

export async function routeToFlow(context: TriggerContext): Promise<void> {
  log('ROUTE', `${context.ticketId} → Flow ${context.flow} (${context.status}, scope:${context.scope}, isRework: ${context.isRework})`);

  try {
    switch (context.flow) {
      case 1:
        await flow1(context);
        break;
      case 2:
        await flow2(context);
        break;
      case 3:
        await flow3(context);
        break;
      default: {
        const exhaustive: never = context.flow;
        log('ERROR', `Unknown flow: ${exhaustive}`);
      }
    }
  } catch (err) {
    log('ERROR', `Error executing Flow ${context.flow} for ${context.ticketId}: ${(err as Error).message}`);
  }
}
