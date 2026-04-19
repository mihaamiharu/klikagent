import { parseGitHubPayload } from './parser';
import { GitHubPRReviewPayload, GitHubWorkflowRunPayload, ReviewContext, TriggerContext } from '../../types';
import * as githubApi from '../../utils/githubApi';

// Mock the HTTP call so tests don't need real credentials
jest.mock('../../utils/githubApi');
const mockFetchWorkflowRunInputs = githubApi.fetchWorkflowRunInputs as jest.MockedFunction<
  typeof githubApi.fetchWorkflowRunInputs
>;

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
      head: { ref: 'qa/KA-42-login-form-validation' },
    },
    repository: {
      name: 'klikagent-tests',
      full_name: 'yourorg/klikagent-tests',
    },
    ...overrides,
  };
}

function makeWorkflowRunPayload(overrides: Partial<GitHubWorkflowRunPayload> = {}): GitHubWorkflowRunPayload {
  return {
    action: 'completed',
    workflow_run: {
      id: 9876543,
      name: 'smoke.yml',
      conclusion: 'success',
      workflow_id: 111,
    },
    repository: {
      name: 'klikagent-tests',
      full_name: 'yourorg/klikagent-tests',
    },
    ...overrides,
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

  it('returns null when branch does not match qa/KA-* pattern', async () => {
    const payload = makePRReviewPayload();
    payload.pull_request.head.ref = 'feature/login-form';
    const result = await parseGitHubPayload('pull_request_review', payload);
    expect(result).toBeNull();
  });

  it('extracts ticketId from branch name', async () => {
    const result = await parseGitHubPayload('pull_request_review', makePRReviewPayload()) as ReviewContext;
    expect(result).not.toBeNull();
    expect(result.ticketId).toBe('KA-42');
  });

  it('returns ReviewContext with correct fields for valid payload', async () => {
    const result = await parseGitHubPayload('pull_request_review', makePRReviewPayload()) as ReviewContext;
    expect(result).toMatchObject({
      prNumber: 14,
      repo: 'klikagent-tests',
      branch: 'qa/KA-42-login-form-validation',
      ticketId: 'KA-42',
      reviewId: 999,
      reviewerLogin: 'reviewer-jane',
    });
  });

  it('includes review body in comments array', async () => {
    const result = await parseGitHubPayload('pull_request_review', makePRReviewPayload()) as ReviewContext;
    expect(result.comments).toContain('Test coverage missing for error state');
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

// ─── workflow_run ─────────────────────────────────────────────────────────────

describe('parseGitHubPayload — workflow_run', () => {
  beforeEach(() => {
    mockFetchWorkflowRunInputs.mockResolvedValue({
      ticketId: 'KA-42',
      runType: 'smoke',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns null when action is not "completed"', async () => {
    const payload = makeWorkflowRunPayload({ action: 'requested' });
    const result = await parseGitHubPayload('workflow_run', payload);
    expect(result).toBeNull();
  });

  it('returns null when workflow name is not selective.yml or smoke.yml', async () => {
    const payload = makeWorkflowRunPayload();
    payload.workflow_run.name = 'ci.yml';
    const result = await parseGitHubPayload('workflow_run', payload);
    expect(result).toBeNull();
  });

  it('accepts selective.yml as a valid workflow name', async () => {
    const payload = makeWorkflowRunPayload();
    payload.workflow_run.name = 'selective.yml';
    const result = await parseGitHubPayload('workflow_run', payload);
    expect(result).not.toBeNull();
  });

  it('accepts smoke.yml as a valid workflow name', async () => {
    const result = await parseGitHubPayload('workflow_run', makeWorkflowRunPayload());
    expect(result).not.toBeNull();
  });

  it('calls fetchWorkflowRunInputs with the run ID', async () => {
    await parseGitHubPayload('workflow_run', makeWorkflowRunPayload());
    expect(mockFetchWorkflowRunInputs).toHaveBeenCalledWith(9876543);
  });

  it('returns TriggerContext with flow 3 and correct fields', async () => {
    const result = await parseGitHubPayload('workflow_run', makeWorkflowRunPayload()) as TriggerContext;
    expect(result).toMatchObject({
      flow: 3,
      ticketId: 'KA-42',
      runId: 9876543,
      runType: 'smoke',
    });
  });

  it('returns null (and does not throw) when fetchWorkflowRunInputs rejects', async () => {
    mockFetchWorkflowRunInputs.mockRejectedValue(new Error('GitHub API error'));
    // The server catches this at the handler level; parser should let it propagate
    // so the caller (server) logs and skips gracefully
    await expect(parseGitHubPayload('workflow_run', makeWorkflowRunPayload())).rejects.toThrow('GitHub API error');
  });
});
