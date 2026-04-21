import { GitHubIssue, GitHubIssueWebhookPayload, GitHubPRReviewPayload, ReviewComment, ReviewContext, TriggerContext } from '../../types';
import { log } from '../../utils/logger';

const TICKET_FROM_BRANCH_RE = /^qa\/(\d+)-/;

function handleIssueLabeled(payload: GitHubIssueWebhookPayload): TriggerContext | null {
  if (payload.action !== 'labeled') {
    log('SKIP', `issues — reason: action is "${payload.action}", not "labeled"`);
    return null;
  }

  const labelName = payload.label?.name ?? '';

  // status:in-progress is a no-op — Flow 1 (skeleton generation) has been removed
  if (labelName === 'status:in-progress') {
    log('INFO', `issues #${payload.issue.number} — status:in-progress is a no-op (Flow 1 removed)`);
    return null;
  }

  if (labelName !== 'status:ready-for-qa') {
    log('SKIP', `issues #${payload.issue.number} — reason: label "${labelName}" is not a trigger`);
    return null;
  }

  const labels = payload.issue.labels.map((l) => l.name);
  const scopeLabel = labels.find((l) => l.startsWith('scope:'));
  const scope = scopeLabel ? (scopeLabel.replace('scope:', '') as 'web' | 'api' | 'both') : 'none';
  const isRework = labels.some((l) => l.startsWith('rework'));
  const parentLabel = labels.find((l) => l.startsWith('parent:'));
  const parentTicketId = parentLabel?.replace('parent:', '');

  const issue: GitHubIssue = {
    number: payload.issue.number,
    title: payload.issue.title,
    body: payload.issue.body ?? '',
    url: payload.issue.html_url,
    labels,
  };

  log('ROUTE', `issues #${issue.number} labeled "${labelName}" → Flow 2`);

  return {
    flow: 2,
    ticketId: String(issue.number),
    ticketSummary: issue.title,
    ticketUrl: issue.url,
    status: labelName,
    previousStatus: '',
    labels,
    scope,
    isRework,
    parentTicketId,
    issue,
    timestamp: new Date().toISOString(),
  };
}

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
    log('SKIP', `PR #${payload.pull_request.number} — reason: branch name doesn't match qa/{number}-* pattern`);
    return null;
  }

  const ticketId = match[1];
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
  if (eventType === 'issues') {
    return handleIssueLabeled(payload as GitHubIssueWebhookPayload);
  }

  if (eventType === 'pull_request_review') {
    return handlePRReview(payload as GitHubPRReviewPayload);
  }

  log('SKIP', `GitHub event "${eventType}" — reason: unhandled event type`);
  return null;
}
