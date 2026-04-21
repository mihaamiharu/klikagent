import { parseGitHubPayload } from './parser';
import { GitHubIssueWebhookPayload, GitHubPRReviewPayload, ReviewContext, TriggerContext } from '../../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePRReviewPayload(overrides: Partial<GitHubPRReviewPayload> = {}): GitHubPRReviewPayload {
  return {
    action: 'submitted',
    review: {
      id: 999,
      state: 'CHANGES_REQUESTED',
      user: { login: 'reviewer-jane' },
      body: 'Test coverage missing for error state',
    },
    pull_request: {
      number: 14,
      draft: false,
      head: { ref: 'qa/42-login-form-validation' },
    },
    repository: {
      name: 'klikagent-tests',
      full_name: 'yourorg/klikagent-tests',
    },
    ...overrides,
  };
}

function makeIssueLabeledPayload(labelName: string): GitHubIssueWebhookPayload {
  return {
    action: 'labeled',
    label: { name: labelName },
    issue: {
      number: 42,
      title: 'Login form validation',
      body: 'As a user I want to validate login...',
      html_url: 'https://github.com/org/repo/issues/42',
      labels: [{ name: labelName }, { name: 'scope:web' }],
    },
    repository: {
      name: 'repo',
      full_name: 'org/repo',
    },
  };
}

// ─── pull_request_review ──────────────────────────────────────────────────────

describe('parseGitHubPayload — pull_request_review', () => {
  it('returns null when action is not "submitted"', async () => {
    const payload = makePRReviewPayload({ action: 'dismissed' });
    const result = await parseGitHubPayload('pull_request_review', payload);
    expect(result).toBeNull();
  });

  it('returns null when review state is not CHANGES_REQUESTED', async () => {
    const payload = makePRReviewPayload();
    payload.review.state = 'APPROVED';
    const result = await parseGitHubPayload('pull_request_review', payload);
    expect(result).toBeNull();
  });

  it('returns null when PR is a draft', async () => {
    const payload = makePRReviewPayload();
    payload.pull_request.draft = true;
    const result = await parseGitHubPayload('pull_request_review', payload);
    expect(result).toBeNull();
  });

  it('returns null when branch does not match qa/{number}-* pattern', async () => {
    const payload = makePRReviewPayload();
    payload.pull_request.head.ref = 'feature/login-form';
    const result = await parseGitHubPayload('pull_request_review', payload);
    expect(result).toBeNull();
  });

  it('extracts ticketId from branch name', async () => {
    const result = await parseGitHubPayload('pull_request_review', makePRReviewPayload()) as ReviewContext;
    expect(result).not.toBeNull();
    expect(result.ticketId).toBe('42');
  });

  it('returns ReviewContext with correct fields for valid payload', async () => {
    const result = await parseGitHubPayload('pull_request_review', makePRReviewPayload()) as ReviewContext;
    expect(result).toMatchObject({
      prNumber: 14,
      repo: 'klikagent-tests',
      branch: 'qa/42-login-form-validation',
      ticketId: '42',
      reviewId: 999,
      reviewerLogin: 'reviewer-jane',
    });
  });

  it('includes review body in comments array', async () => {
    const result = await parseGitHubPayload('pull_request_review', makePRReviewPayload()) as ReviewContext;
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body).toBe('Test coverage missing for error state');
  });

  it('produces empty comments array when review body is null', async () => {
    const payload = makePRReviewPayload();
    payload.review.body = null;
    const result = await parseGitHubPayload('pull_request_review', payload) as ReviewContext;
    expect(result.comments).toEqual([]);
  });

  it('returns null for unrecognised event type', async () => {
    const result = await parseGitHubPayload('push', {});
    expect(result).toBeNull();
  });
});

// ─── issues ───────────────────────────────────────────────────────────────────

describe('parseGitHubPayload — issues', () => {
  it('returns null for status:in-progress (no-op — Flow 1 removed)', async () => {
    const payload = makeIssueLabeledPayload('status:in-progress');
    const result = await parseGitHubPayload('issues', payload);
    expect(result).toBeNull();
  });

  it('returns TriggerContext with flow 2 for status:ready-for-qa', async () => {
    const payload = makeIssueLabeledPayload('status:ready-for-qa');
    const result = await parseGitHubPayload('issues', payload) as TriggerContext;
    expect(result).not.toBeNull();
    expect(result.flow).toBe(2);
    expect(result.ticketId).toBe('42');
    expect(result.status).toBe('status:ready-for-qa');
  });

  it('returns null for unrelated label', async () => {
    const payload = makeIssueLabeledPayload('priority:high');
    const result = await parseGitHubPayload('issues', payload);
    expect(result).toBeNull();
  });

  it('returns null when action is not "labeled"', async () => {
    const payload = makeIssueLabeledPayload('status:ready-for-qa');
    payload.action = 'closed';
    const result = await parseGitHubPayload('issues', payload);
    expect(result).toBeNull();
  });

  it('returns null for workflow_run (Flow 3 removed)', async () => {
    const result = await parseGitHubPayload('workflow_run', {});
    expect(result).toBeNull();
  });
});
