import { TriggerContext } from '../types';
import { log } from '../utils/logger';

export async function flow1(context: TriggerContext): Promise<void> {
  log('INFO', `[Flow 1] ${context.ticketId} triggered — TODO: Phase 3 will generate tests`);
  log('INFO', `[Flow 1] TODO (Phase 3): Read full ticket via Jira MCP → generate Playwright tests → commit to branch qa/${context.ticketId}-short-summary → open PR (draft) → comment on Jira`);
}
