import { ReviewContext } from '../types';
import { runAgent, TokenUsage } from '../services/ai';
import { reviewTools, reviewHandlers } from './tools';

const SYSTEM_PROMPT = `You are a senior QA engineer responding to code review feedback on a Playwright test PR.

A human reviewer has left CHANGES_REQUESTED comments on your test PR.
Your job is to fix every issue raised and reply to each comment thread.

Rules:
- Address every inline review comment — do not ignore any
- Fix the spec and/or POM as needed
- Replies must start with "[KlikAgent] Fixed:" or "[KlikAgent] Noted:" (if no code change needed)
- Never remove existing passing tests — only fix what was flagged
- Keep the same coding style as the existing spec
- Use relative imports — never @pages, @helpers, @data aliases
- Call validate_typescript before done()
- Call done() with fixedSpec, pomContent, and a commentReplies entry for every comment id`;

function buildUserMessage(ctx: ReviewContext, feature: string | undefined): string {
  const comments = ctx.comments
    .map((c) => `[id:${c.id}] ${c.path}:${c.line ?? '?'}\n${c.body}`)
    .join('\n\n---\n\n');

  const featureHint = feature
    ? `Feature hint (verify against list_available_poms): ${feature}`
    : 'Feature: not provided — derive it from the branch name, file paths in review comments, and list_available_poms output';

  return `
## PR Review
PR #${ctx.prNumber} on ${ctx.repo}
Branch: ${ctx.branch}
Ticket: #${ctx.ticketId}
Reviewer: ${ctx.reviewerLogin}
${featureHint}

## Review Comments
${comments}

## Your task
1. Call get_context_docs and get_fixtures for project conventions
2. Call list_available_poms to verify the feature folder and available POMs
3. Use get_current_pom (branch, feature) to read the current POM on this branch
4. Use get_skeleton_spec (branch, ticketId, feature) to read the current spec
5. Fix every issue raised in the review comments
6. Call validate_typescript to confirm the fixed spec compiles
7. Call done() with:
   - fixedSpec: the complete fixed spec file
   - pomContent: the complete POM file (updated if needed)
   - commentReplies: one entry per comment id with your reply text
`.trim();
}

export async function runReviewAgent(
  ctx: ReviewContext,
  feature: string | undefined
): Promise<{
  fixedSpec: string;
  pomContent: string;
  commentReplies: Array<{ commentId: number; body: string }>;
  tokenUsage: TokenUsage;
}> {
  const { args, tokenUsage } = await runAgent(
    SYSTEM_PROMPT,
    buildUserMessage(ctx, feature),
    reviewTools,
    reviewHandlers
  );
  return {
    fixedSpec: args.fixedSpec as string,
    pomContent: args.pomContent as string,
    commentReplies: args.commentReplies as Array<{ commentId: number; body: string }>,
    tokenUsage,
  };
}
