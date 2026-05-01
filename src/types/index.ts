// ─── Explorer → Writer handoff ───────────────────────────────────────────────

export interface ObservedFlow {
  name: string;     // e.g. "patient login success"
  steps: string;    // e.g. "navigate /login → fill email → click submit → redirect /dashboard"
  observed: string; // e.g. "welcome heading visible, user name and role shown in nav"
}

export interface MissingLocator {
  route: string;  // e.g. "/dashboard"
  name: string;   // e.g. "logoutButton"
  reason: string; // e.g. "button not present in snapshot after login"
}

// Structured handoff from explorerAgent to writerAgent.
// locators are grouped by route so the writer knows exactly which page each element lives on.
export interface ExplorationReport {
  feature: string;
  visitedRoutes: string[];                              // e.g. ["/login", "/dashboard"]
  authPersona: string;
  locators: Record<string, Record<string, string>>;     // route → name → generatedCode
  flows: ObservedFlow[];
  missingLocators: MissingLocator[];
  notes: string[];                                      // behavioral observations
}

// Pre-fetched repo context injected into writerAgent — no tool calls needed from the writer.
export interface WriterContext {
  fixtures: string;
  personas: string;
  contextDocs: string;
  availablePoms: string[];
  existingTests: Record<string, string>;
  existingPom: string | null;
  goldenExamples: string;
}

// ─── QA Task (normalized payload from trigger services) ───────────────────────

// Trigger services (klikagent-github-trigger, jira-trigger, etc.) translate
// their source events into this shape before calling POST /tasks.
export interface QATask {
  taskId: string;                  // e.g. "42" (GitHub issue number) or "JIRA-123"
  title: string;                   // ticket title
  description: string;             // acceptance criteria / ticket body
  qaEnvUrl: string;                // QA environment URL to test against
  outputRepo: string;              // repo to commit specs to (e.g. "klikagent-tests")
  feature?: string;                // feature area e.g. "auth", "billing" — routes spec path
  callbackUrl?: string;            // if set, KlikAgent POSTs TaskResult here when done
  metadata?: Record<string, unknown>;  // source-specific extras (e.g. issueUrl, labels)
}

// A single test failure from a CI run — posted to POST /api/runs/:id/fix
export interface CiTestFailure {
  testName: string;      // full test title from Playwright output
  errorMessage: string;  // full error including Expected/Received lines
  filePath?: string;     // spec file path e.g. "tests/web/auth/auth-flow.spec.ts"
}

// Payload sent by CI to POST /tasks/:id/results after test run
export interface TaskResult {
  taskId: string;
  passed: boolean;
  summary: string;                 // human-readable result (e.g. "12 passed, 2 failed")
  reportUrl?: string;              // link to CI HTML report or artifact
  metadata?: Record<string, unknown>;
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
  repo: string;                   // e.g. "klikagent-tests" (kept for backwards compat)
  outputRepo: string;             // repo to read/write — always use this for agent operations
  branch: string;                 // e.g. "qa/42-login-validation"
  ticketId: string;               // extracted from branch name
  reviewId: number;
  reviewerLogin: string;
  comments: ReviewComment[];      // inline review comments (fetched at parse time)
  specPath: string;               // repo-relative path to the spec file e.g. "tests/web/auth/qa-auth-flow.spec.ts"
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

// Snapshot of a page captured by the Playwright browser tools.
// ariaTree is a YAML string from Playwright's ariaSnapshot({ mode: 'ai' }) —
// the format is optimized for AI consumption and passed directly to agents.
export interface PageSnapshot {
  url: string;
  ariaTree: string;               // ARIA YAML snapshot (Playwright 1.48+ ariaSnapshot API)
  interactables: Array<{          // interactive elements with pre-computed Playwright locators
    role: string;
    label: string;
    selector: string;
  }>;
}

// ─── Agent output ─────────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  content: string;
  role: 'spec' | 'pom' | 'fixture' | 'extra';
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

// ─── Repo Provisioner ─────────────────────────────────────────────────────────

export interface PersonaSeed {
  email: string;
  password: string;
  displayName?: string;
  role?: string;
}

export interface ProvisionRequest {
  repoName: string;       // GitHub repo name to create e.g. "myteam-tests"
  owner: string;          // GitHub org or user
  qaEnvUrl: string;       // base URL of the QA environment (seeded into playwright.config.ts)
  features: string[];     // feature areas e.g. ["auth", "billing", "dashboard"]
  domainContext: string;  // paragraph describing the app — seeded into context/domain.md
  personas?: Record<string, PersonaSeed>; // persona credentials seeded into config/personas.json
}

export interface ProvisionResult {
  repoUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}
