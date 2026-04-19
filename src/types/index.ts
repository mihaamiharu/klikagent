// ─── GitHub Issues (replaces Jira) ────────────────────────────────────────────

// Raw GitHub Issues webhook payload for `issues` event
export interface GitHubIssueWebhookPayload {
  action: string;               // e.g. "labeled"
  label?: {
    name: string;               // e.g. "status:in-progress"
  };
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: {
    name: string;
    full_name: string;
  };
}

// Clean issue object used by the issues service
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;                 // empty string if null
  url: string;
  labels: string[];
}

// ─── Jira (kept for Phase 2 backward compat — deleted in Task 4.5) ────────────

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

// ─── Trigger context ──────────────────────────────────────────────────────────

// Clean handoff object passed to the orchestrator
// ticketId = GitHub issue number as string (e.g. "42")
export interface TriggerContext {
  flow: 1 | 2 | 3;
  ticketId: string;               // GitHub issue number e.g. "42"
  ticketSummary: string;          // issue title
  ticketUrl: string;              // e.g. "https://github.com/owner/repo/issues/42"
  status: string;                 // triggering label e.g. "status:in-progress"
  previousStatus: string;         // empty string for label-based triggers
  labels: string[];               // all labels on the issue
  scope: 'web' | 'api' | 'both' | 'none';  // parsed from scope:* label
  isRework: boolean;              // true if issue has rework:* label
  parentTicketId?: string;        // parent issue number if rework subtask
  project?: string;               // @deprecated — Jira project key (removed in Task 4.5)
  // Flow 3 only — populated from workflow_run event
  runId?: number;                 // GitHub Actions run ID
  runType?: 'new-tests' | 'affected' | 'smoke';
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
      ref: string;                // branch name e.g. "qa/42-login-validation"
    };
  };
  repository: {
    name: string;
    full_name: string;
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
    html_url: string;             // run URL for linking in comments
  };
  repository: {
    name: string;
    full_name: string;
  };
}

// GitHub Actions run inputs — fetched via API, not in webhook payload
export interface WorkflowRunInputs {
  ticketId: string;               // e.g. "42"
  runType: 'new-tests' | 'affected' | 'smoke';
}

// A single inline review comment on a PR
export interface ReviewComment {
  id: number;
  path: string;                   // file path e.g. "tests/web/auth/42.spec.ts"
  line: number | null;            // line number in the file (null for file-level)
  body: string;
  diffHunk: string;               // the @@ ... @@ context block
}

// Clean handoff object for the Review Agent
export interface ReviewContext {
  prNumber: number;
  repo: string;                   // e.g. "klikagent-tests"
  branch: string;                 // e.g. "qa/42-login-validation"
  ticketId: string;               // extracted from branch name
  reviewId: number;
  reviewerLogin: string;
  comments: ReviewComment[];      // inline review comments (fetched at parse time)
}

// A GitHub pull request (used by CI gate and test repo service)
export interface PR {
  number: number;
  branch: string;                 // head ref
  headSha: string;
  url: string;
  isDraft: boolean;
}

// Result of a CI check-run gate
export interface CIResult {
  passed: boolean;
  conclusion: string;             // e.g. "success", "failure", "pending"
  checkRunUrl: string;
  prUrl: string;
}

// A comment on a GitHub issue or PR
export interface PRComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

// ─── Playwright crawler ───────────────────────────────────────────────────────

// Snapshot of a page captured by the Playwright crawler.
// ariaTree is a YAML string from Playwright's ariaSnapshot({ mode: 'ai' }) —
// the format is optimized for AI consumption and passed directly to agents.
export interface PageSnapshot {
  url: string;
  ariaTree: string;               // ARIA YAML snapshot (Playwright 1.48+ ariaSnapshot API)
  testIds: string[];              // data-testid attribute values found on the page
  htmlSample: string;             // first 500 chars of body outerHTML for fallback
}

// ─── Agent tool loop ──────────────────────────────────────────────────────────

// A tool definition passed to the AI agent (OpenAI function calling format)
export interface AgentTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;  // JSON Schema object
  };
}

// Map of tool name → async handler function
export type ToolHandlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

// ─── Handlers ─────────────────────────────────────────────────────────────────

export type FlowHandler = (context: TriggerContext) => Promise<void>;
export type ReviewHandler = (context: ReviewContext) => Promise<void>;
