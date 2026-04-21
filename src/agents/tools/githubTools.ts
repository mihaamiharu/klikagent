import { AgentTool, ToolHandlers } from '../../types';
import { getReviewComments, ownerName, testRepoName } from '../../services/github';

export const githubToolDefs: AgentTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_full_review_comments',
      description: 'Fetch all inline review comments for a PR review from GitHub.',
      parameters: {
        type: 'object',
        properties: {
          prNumber: { type: 'number', description: 'Pull request number' },
          reviewId: { type: 'number', description: 'Review ID' },
        },
        required: ['prNumber', 'reviewId'],
      },
    },
  },
];

export const githubToolHandlers: ToolHandlers = {
  get_full_review_comments: async (args) => {
    const comments = await getReviewComments(
      args.prNumber as number,
      args.reviewId as number,
      testRepoName()
    );
    return comments
      .map((c) => `[id:${c.id}] ${c.path}:${c.line ?? '?'}\n${c.body}\n\nDiff:\n${c.diffHunk}`)
      .join('\n\n---\n\n');
  },
};
