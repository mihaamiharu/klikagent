import { parseJiraPayload } from './parser';
import { JiraWebhookPayload } from '../../types';

// Baseline valid payload — moves KA-42 to "In Progress"
function makePayload(overrides: Partial<JiraWebhookPayload> = {}): JiraWebhookPayload {
  return {
    webhookEvent: 'jira:issue_updated',
    issue: {
      key: 'KA-42',
      self: 'https://test.atlassian.net/rest/api/3/issue/KA-42',
      fields: {
        summary: 'Login form validation',
        status: { name: 'In Progress' },
        project: { key: 'KA' },
        labels: ['scope:web'],
        issuetype: { name: 'Story' },
      },
    },
    changelog: {
      items: [{ field: 'status', fromString: 'Backlog', toString: 'In Progress' }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.JIRA_PROJECT_KEY = 'KA';
  process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
});

afterEach(() => {
  delete process.env.JIRA_PROJECT_KEY;
  delete process.env.JIRA_BASE_URL;
});

// ─── Skip conditions ──────────────────────────────────────────────────────────

describe('parseJiraPayload — skip conditions', () => {
  it('returns null when webhookEvent is not jira:issue_updated', () => {
    const result = parseJiraPayload(makePayload({ webhookEvent: 'jira:issue_created' }));
    expect(result).toBeNull();
  });

  it('returns null when changelog is absent', () => {
    const payload = makePayload();
    delete payload.changelog;
    const result = parseJiraPayload(payload);
    expect(result).toBeNull();
  });

  it('returns null when changelog has no status change item', () => {
    const result = parseJiraPayload(makePayload({
      changelog: { items: [{ field: 'assignee', fromString: 'Alice', toString: 'Bob' }] },
    }));
    expect(result).toBeNull();
  });

  it('returns null when project key does not match JIRA_PROJECT_KEY', () => {
    const payload = makePayload();
    payload.issue.fields.project.key = 'OTHER';
    const result = parseJiraPayload(payload);
    expect(result).toBeNull();
  });

  it('returns null when labels include scope:none', () => {
    const payload = makePayload();
    payload.issue.fields.labels = ['scope:none'];
    const result = parseJiraPayload(payload);
    expect(result).toBeNull();
  });

  it('returns null when status maps to no label (e.g. "In QA")', () => {
    const result = parseJiraPayload(makePayload({
      changelog: { items: [{ field: 'status', fromString: 'Backlog', toString: 'In QA' }] },
    }));
    expect(result).toBeNull();
  });

  it('returns null when no scope label is present', () => {
    const payload = makePayload();
    payload.issue.fields.labels = ['unrelated-label'];
    const result = parseJiraPayload(payload);
    expect(result).toBeNull();
  });
});

// ─── Status label mapping ──────────────────────────────────────────────────────

describe('parseJiraPayload — status label mapping', () => {
  it.each([
    ['In Progress',  'status:in-progress'],
    ['Ready for QA', 'status:ready-for-qa'],
    ['Done',         'status:done'],
  ] as const)('maps Jira status "%s" to label "%s"', (jiraStatus, expectedLabel) => {
    const result = parseJiraPayload(makePayload({
      changelog: { items: [{ field: 'status', fromString: 'Backlog', toString: jiraStatus }] },
    }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(expectedLabel);
    expect(result!.flow).toBe(2);
  });
});

// ─── Scope parsing ────────────────────────────────────────────────────────────

describe('parseJiraPayload — scope parsing', () => {
  it.each([
    [['scope:web'], 'web'],
    [['scope:api'], 'api'],
    [['scope:both'], 'both'],
    [['scope:web', 'scope:api'], 'both'],
  ] as const)('parses labels %j as scope "%s"', (labels, expectedScope) => {
    const payload = makePayload();
    payload.issue.fields.labels = [...labels];
    const result = parseJiraPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.scope).toBe(expectedScope);
  });
});

// ─── TriggerContext fields ────────────────────────────────────────────────────

describe('parseJiraPayload — context fields', () => {
  it('returns correct base fields for a valid payload', () => {
    const result = parseJiraPayload(makePayload());
    expect(result).toMatchObject({
      flow: 2,
      ticketId: 'KA-42',
      ticketSummary: 'Login form validation',
      ticketUrl: 'https://test.atlassian.net/browse/KA-42',
      status: 'status:in-progress',
      previousStatus: 'Backlog',
      scope: 'web',
      isRework: false,
    });
  });

  it('builds ticketUrl from JIRA_BASE_URL env var', () => {
    process.env.JIRA_BASE_URL = 'https://custom.atlassian.net';
    const result = parseJiraPayload(makePayload());
    expect(result!.ticketUrl).toBe('https://custom.atlassian.net/browse/KA-42');
  });

  it('sets isRework to true when issuetype is Rework', () => {
    const payload = makePayload();
    payload.issue.fields.issuetype.name = 'Rework';
    const result = parseJiraPayload(payload);
    expect(result!.isRework).toBe(true);
  });

  it('sets isRework to false for non-Rework issue types', () => {
    const payload = makePayload();
    payload.issue.fields.issuetype.name = 'Bug';
    const result = parseJiraPayload(payload);
    expect(result!.isRework).toBe(false);
  });

  it('sets parentTicketId when parent is present', () => {
    const payload = makePayload();
    payload.issue.fields.parent = { key: 'KA-40' };
    const result = parseJiraPayload(payload);
    expect(result!.parentTicketId).toBe('KA-40');
  });

  it('leaves parentTicketId undefined when no parent', () => {
    const result = parseJiraPayload(makePayload());
    expect(result!.parentTicketId).toBeUndefined();
  });

  it('passes labels through raw and unfiltered', () => {
    const payload = makePayload();
    payload.issue.fields.labels = ['scope:web', 'priority:high', 'team:core'];
    const result = parseJiraPayload(payload);
    expect(result!.labels).toEqual(['scope:web', 'priority:high', 'team:core']);
  });

  it('sets a valid ISO 8601 timestamp', () => {
    const before = new Date().toISOString();
    const result = parseJiraPayload(makePayload());
    const after = new Date().toISOString();
    expect(result!.timestamp >= before).toBe(true);
    expect(result!.timestamp <= after).toBe(true);
  });

  it('does not include a project field (removed from TriggerContext)', () => {
    const result = parseJiraPayload(makePayload());
    expect(result).not.toBeNull();
    expect((result as unknown as Record<string, unknown>)['project']).toBeUndefined();
  });
});

// ─── JIRA_PROJECT_KEY not set (skip validation) ───────────────────────────────

describe('parseJiraPayload — JIRA_PROJECT_KEY not set', () => {
  it('skips project key check when JIRA_PROJECT_KEY env var is not set', () => {
    delete process.env.JIRA_PROJECT_KEY;
    const payload = makePayload();
    payload.issue.fields.project.key = 'ANYTHING';
    const result = parseJiraPayload(payload);
    expect(result).not.toBeNull();
  });
});
