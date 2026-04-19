import { ReviewContext } from '../types';
import { log } from '../utils/logger';

export async function reviewAgent(context: ReviewContext): Promise<void> {
  log('REVIEW', `${context.ticketId} PR #${context.prNumber} triggered — TODO: Phase 3 will handle rework`);
  log('REVIEW', `[Review Agent] TODO (Phase 3): Read CHANGES_REQUESTED review comments → prompt Claude to revise failing tests → commit fixes to same branch → re-request review → comment on Jira ticket`);
}
