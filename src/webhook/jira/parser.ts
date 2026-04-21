import { JiraWebhookPayload, TriggerContext } from '../../types';
import { log } from '../../utils/logger';

// Only "Ready for QA" triggers the flow — other statuses are no-ops at the parser level.
// status:in-progress and other statuses are handled by the orchestrator as no-ops.
const STATUS_TO_LABEL: Record<string, string> = {
  'In Progress':  'status:in-progress',
  'Ready for QA': 'status:ready-for-qa',
  'Done':         'status:done',
};

function parseScope(labels: string[]): 'web' | 'api' | 'both' | 'none' {
  const hasWeb = labels.includes('scope:web');
  const hasApi = labels.includes('scope:api');
  const hasBoth = labels.includes('scope:both');

  if (hasBoth) return 'both';
  if (hasWeb && hasApi) return 'both';
  if (hasWeb) return 'web';
  if (hasApi) return 'api';
  return 'none';
}

export function parseJiraPayload(payload: JiraWebhookPayload): TriggerContext | null {
  const issueKey = payload.issue?.key ?? 'UNKNOWN';

  if (payload.webhookEvent !== 'jira:issue_updated') {
    log('SKIP', `${issueKey} — reason: not a jira:issue_updated event`);
    return null;
  }

  if (!payload.changelog) {
    log('SKIP', `${issueKey} — reason: no changelog present`);
    return null;
  }

  const statusChange = payload.changelog.items.find((item) => item.field === 'status');
  if (!statusChange) {
    log('SKIP', `${issueKey} — reason: not a status change event`);
    return null;
  }

  const projectKey = process.env.JIRA_PROJECT_KEY;
  if (projectKey && payload.issue.fields.project.key !== projectKey) {
    log('SKIP', `${issueKey} — reason: project key "${payload.issue.fields.project.key}" does not match ${projectKey}`);
    return null;
  }

  const labels = payload.issue.fields.labels;

  if (labels.includes('scope:none')) {
    log('SKIP', `${issueKey} — reason: scope:none label present`);
    return null;
  }

  const newStatus = statusChange.toString;
  const statusLabel = STATUS_TO_LABEL[newStatus];

  if (statusLabel === undefined) {
    log('SKIP', `${issueKey} — reason: status "${newStatus}" has no mapped label`);
    return null;
  }

  const scope = parseScope(labels);
  if (scope === 'none') {
    log('SKIP', `${issueKey} — reason: no scope label found (scope:web, scope:api, or scope:both required)`);
    return null;
  }

  const jiraBaseUrl = process.env.JIRA_BASE_URL ?? '';
  const ticketUrl = `${jiraBaseUrl}/browse/${issueKey}`;

  const context: TriggerContext = {
    flow: 2,
    ticketId: issueKey,
    ticketSummary: payload.issue.fields.summary,
    ticketUrl,
    status: statusLabel,
    previousStatus: statusChange.fromString,
    labels,
    scope,
    isRework: payload.issue.fields.issuetype.name === 'Rework',
    parentTicketId: payload.issue.fields.parent?.key ?? undefined,
    timestamp: new Date().toISOString(),
  };

  return context;
}
