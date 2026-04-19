// ─── Jira ─────────────────────────────────────────────────────────────────────

// Raw Jira webhook payload (subset of fields we care about)
export interface JiraWebhookPayload {
  webhookEvent: string;           // e.g. "jira:issue_updated"
  issue: {
    key: string;                  // e.g. "KA-42"
    self: string;                 // full API URL to the issue
    fields: {
      summary: string;
      status: {
        name: string;             // e.g. "In Progress"
      };
      project: {
        key: string;              // e.g. "KA"
      };
      labels: string[];           // e.g. ["scope:web", "scope:api"]
      description?: string;
      issuetype: {
        name: string;             // e.g. "Story", "Bug", "Rework"
      };
      parent?: {
        key: string;              // e.g. "KA-40" — parent ticket if exists
      };
    };
  };
  changelog?: {
    items: Array<{
      field: string;              // e.g. "status"
      fromString: string;         // previous status name
      toString: string;           // new status name
    }>;
  };
}

// Clean handoff object passed to the orchestrator (Phase 3)
export interface TriggerContext {
  flow: 1 | 2 | 3;
  ticketId: string;               // e.g. "KA-42"
  ticketSummary: string;
  ticketUrl: string;              // e.g. "https://yourworkspace.atlassian.net/browse/KA-42"
  status: string;                 // the new status that triggered the event
  previousStatus: string;         // the status it came from
  project: string;                // Jira project key
  labels: string[];               // all labels on the ticket, passed raw for Phase 3 scope guard
  scope: 'web' | 'api' | 'both' | 'none';  // parsed from labels
  isRework: boolean;              // true if issue type === "Rework"
  parentTicketId?: string;        // parent ticket key if present (e.g. "KA-40")
  // Flow 3 only — populated from workflow_run event
  runId?: number;                 // GitHub Actions run ID
  runType?: 'new-tests' | 'affected' | 'smoke';  // which workflow completed
  timestamp: string;              // ISO 8601
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

// Incoming pull_request_review webhook payload (subset)
export interface GitHubPRReviewPayload {
  action: string;                 // e.g. "submitted"
  review: {
    id: number;
    state: string;                // e.g. "CHANGES_REQUESTED", "APPROVED"
    user: {
      login: string;
    };
    body: string | null;
  };
  pull_request: {
    number: number;
    draft: boolean;
    head: {
      ref: string;                // branch name e.g. "qa/KA-42-login-validation"
    };
  };
  repository: {
    name: string;                 // e.g. "klikagent-tests"
    full_name: string;            // e.g. "yourorg/klikagent-tests"
  };
}

// Incoming workflow_run webhook payload (subset)
export interface GitHubWorkflowRunPayload {
  action: string;                 // e.g. "completed"
  workflow_run: {
    id: number;
    name: string;                 // e.g. "selective.yml" or "smoke.yml"
    conclusion: string;           // e.g. "success", "failure"
    workflow_id: number;
  };
  repository: {
    name: string;
    full_name: string;
  };
}

// GitHub Actions run inputs — fetched via API, not in webhook payload
export interface WorkflowRunInputs {
  ticketId: string;               // e.g. "KA-42"
  runType: 'new-tests' | 'affected' | 'smoke';
}

// Clean handoff object for the Review Agent
export interface ReviewContext {
  prNumber: number;
  repo: string;                   // e.g. "klikagent-tests"
  branch: string;                 // e.g. "qa/KA-42-login-validation"
  ticketId: string;               // extracted from branch name
  reviewId: number;
  reviewerLogin: string;
  comments: string[];             // review comment bodies
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export type FlowHandler = (context: TriggerContext) => Promise<void>;
export type ReviewHandler = (context: ReviewContext) => Promise<void>;
