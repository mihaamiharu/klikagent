import { TriggerContext } from '../types';
import { log } from '../utils/logger';
import { runSkeletonAgent } from '../agents/skeletonAgent';
import { getIssue, commentOnIssue } from '../services/issues';
import { detectFeature } from '../utils/featureDetector';
import { toBranchSlug } from '../utils/naming';
import {
  getDefaultBranchSha,
  createBranch,
  commitFile,
  testRepoName,
  ownerName,
} from '../services/github';

export async function flow1(context: TriggerContext): Promise<void> {
  log('INFO', `[Flow 1] Starting for issue #${context.ticketId}`);

  const issue = context.issue ?? await getIssue(Number(context.ticketId));
  const feature = detectFeature(issue.body, issue.labels);
  const branch = toBranchSlug(context.ticketId, issue.title);
  const specPath = `tests/web/${feature}/${context.ticketId}.spec.ts`;

  log('INFO', `[Flow 1] Feature: ${feature}, Branch: ${branch}`);

  const skeleton = await runSkeletonAgent(issue, feature, branch, context.isRework, context.parentTicketId);

  const baseSha = await getDefaultBranchSha(testRepoName());
  await createBranch(testRepoName(), branch, baseSha);
  await commitFile(
    testRepoName(),
    branch,
    specPath,
    skeleton,
    `chore(skeleton): #${context.ticketId} ${issue.title} [klikagent]`,
  );

  await commentOnIssue(
    Number(context.ticketId),
    `🤖 **KlikAgent** — Skeleton spec generated!\n\n` +
    `Branch: \`${branch}\`\n` +
    `Spec: \`${specPath}\`\n\n` +
    `Committed to [klikagent-tests](https://github.com/${ownerName()}/${testRepoName()}/tree/${branch}).\n\n` +
    `Move this issue to \`status:ready-for-qa\` to run enrichment with real selectors.`,
  );

  log('INFO', `[Flow 1] Done — skeleton committed to ${branch}`);
}
