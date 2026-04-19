import { TriggerContext } from '../types';
import { log } from '../utils/logger';
import { commentOnIssue, addLabel, removeLabel } from '../services/issues';
import { findPRByTicketId, createIssueComment, testRepoName } from '../services/github';

export async function flow3(context: TriggerContext): Promise<void> {
  log('INFO', `[Flow 3] Ticket: ${context.ticketId}, runType: ${context.runType}, conclusion: ${context.runConclusion}`);

  const passed = context.runConclusion === 'success';
  const runLabel = context.runType === 'smoke'
    ? 'Smoke'
    : context.runType === 'affected'
      ? 'Regression'
      : 'New Tests';
  const emoji = passed ? '✅' : '❌';
  const runLink = context.runUrl ? ` ([view run](${context.runUrl}))` : '';
  const resultLine = `${emoji} **${runLabel} run ${passed ? 'passed' : 'failed'}**${runLink}`;

  // Post comment on QA PR in klikagent-tests
  const pr = await findPRByTicketId(context.ticketId, testRepoName()).catch(() => null);
  if (pr) {
    await createIssueComment(
      testRepoName(),
      pr.number,
      `🤖 **KlikAgent CI Result**\n\n${resultLine}\n\nRun ID: \`${context.runId}\``,
    );
    log('INFO', `[Flow 3] Commented on PR #${pr.number} in ${testRepoName()}`);
  } else {
    log('WARN', `[Flow 3] No QA PR found for ticket ${context.ticketId}`);
  }

  // Comment on the issue in the main repo
  await commentOnIssue(
    Number(context.ticketId),
    `🤖 **KlikAgent** — ${runLabel} run completed\n\n${resultLine}`,
  ).catch((err) => log('WARN', `[Flow 3] Could not comment on issue: ${(err as Error).message}`));

  // Smoke run passed → transition to status:done
  if (passed && context.runType === 'smoke') {
    await Promise.all([
      addLabel(Number(context.ticketId), 'status:done'),
      removeLabel(Number(context.ticketId), 'status:in-qa'),
    ]);
    log('INFO', `[Flow 3] Issue #${context.ticketId} transitioned to status:done`);
  }

  log('INFO', `[Flow 3] Done`);
}
