import { GitHubPRReviewPayload, ReviewComment, ReviewContext, TriggerContext } from '../../types';
import { log } from '../../utils/logger';

const TICKET_FROM_BRANCH_RE = /^qa\/(KA-\d+)-/;

async function handlePRReview(payload: GitHubPRReviewPayload): Promise<ReviewContext | null> {
  if (payload.action !== 'submitted') {
    log('SKIP', `PR #${payload.pull_request.number} — reason: action is "${payload.action}", not "submitted"`);
    return null;
  }

  if (payload.review.state !== 'CHANGES_REQUESTED') {
    log('SKIP', `PR #${payload.pull_request.number} — reason: review state is "${payload.review.state}", not CHANGES_REQUESTED`);
    return null;
  }

  if (payload.pull_request.draft === true) {
    log('SKIP', `PR #${payload.pull_request.number} — reason: draft PR, skeleton branch`);
    return null;
  }

  const branch = payload.pull_request.head.ref;
  const match = branch.match(TICKET_FROM_BRANCH_RE);
  if (!match) {
    log('SKIP', `PR #${payload.pull_request.number} — reason: branch name doesn't match qa/KA-* pattern`);
    return null;
  }

  const ticketId = match[1];
  // TODO (Task 4.5): fetch real inline comments via GitHub API
  // For now, wrap the top-level review body as a synthetic ReviewComment
  const comments: ReviewComment[] = [];

  if (payload.review.body) {
    comments.push({ id: 0, path: '', line: null, body: payload.review.body, diffHunk: '' });
  }

  log('ROUTE', `PR #${payload.pull_request.number} → Review Agent (${ticketId}, CHANGES_REQUESTED)`);

  return {
    prNumber: payload.pull_request.number,
    repo: payload.repository.name,
    branch,
    ticketId,
    reviewId: payload.review.id,
    reviewerLogin: payload.review.user.login,
    comments,
  };
}

export async function parseGitHubPayload(
  eventType: string,
  payload: unknown
): Promise<TriggerContext | ReviewContext | null> {
  if (eventType === 'pull_request_review') {
    return handlePRReview(payload as GitHubPRReviewPayload);
  }

  log('SKIP', `GitHub event "${eventType}" — reason: unhandled event type`);
  return null;
}
