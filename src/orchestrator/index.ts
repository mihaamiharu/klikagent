import { TriggerContext } from '../types';
import { log } from '../utils/logger';
import { generateQaSpecFlow } from './generateQaSpecFlow';

/**
 * Central orchestrator — routes GitHub issue label events to the correct flow.
 *
 * Status routing:
 *   status:ready-for-qa  → generateQaSpecFlow (Task 8/9)
 *   status:in-progress   → no-op (log and return)
 *   anything else        → log and return
 */
export async function orchestrate(context: TriggerContext): Promise<void> {
  log('ROUTE', `[orchestrator] #${context.ticketId} status="${context.status}"`);

  if (context.status === 'status:in-progress') {
    log('SKIP', `[orchestrator] #${context.ticketId} — status:in-progress is a no-op`);
    return;
  }

  if (context.status === 'status:ready-for-qa') {
    await generateQaSpecFlow(context);
    return;
  }

  log('SKIP', `[orchestrator] #${context.ticketId} — unrecognised status "${context.status}", skipping`);
}
