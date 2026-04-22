// ─── QA Task (normalized payload from trigger services) ───────────────────────

// Trigger services (klikagent-github-trigger, jira-trigger, etc.) translate
// their source events into this shape before calling POST /tasks.
export interface QATask {
  taskId: string;                  // e.g. "42" (GitHub issue number) or "JIRA-123"
  title: string;                   // ticket title
  description: string;             // acceptance criteria / ticket body
  qaEnvUrl: string;                // QA environment URL to test against
  outputRepo: string;              // repo to commit specs to (e.g. "klikagent-tests")
  metadata?: Record<string, unknown>;  // source-specific extras (e.g. issueUrl, labels)
}

// Payload sent by CI to POST /tasks/:id/results after test run
export interface TaskResult {
  taskId: string;
  passed: boolean;
  summary: string;                 // human-readable result (e.g. "12 passed, 2 failed")
  reportUrl?: string;              // link to CI HTML report or artifact
  metadata?: Record<string, unknown>;
}

// ─── GitHub Issues ────────────────────────────────────────────────────────────

// Clean issue object used by the issues service
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;                 // empty string if null
  url: string;
  labels: string[];
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

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
  locators: string[];             // pre-computed Playwright locators for all interactable elements
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

export type QATaskHandler = (task: QATask) => Promise<void>;
export type ReviewHandler = (context: ReviewContext) => Promise<void>;
