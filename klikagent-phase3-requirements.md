# KlikAgent — Phase 3: Claude Orchestrator
### Requirements Document v2.5
> *Delegate the clicking. Orchestrate the agent.*

---

## Table of Contents
1. [Purpose & Scope](#1-purpose--scope)
2. [Project Context](#2-project-context)
3. [Design Decisions & Constraints](#3-design-decisions--constraints)
4. [File Structure](#4-file-structure)
5. [Flow Specifications](#5-flow-specifications)
6. [Rework Flow](#6-rework-flow)
7. [Page Snapshot System](#7-page-snapshot-system)
8. [Test Generation Agents](#8-test-generation-agents)
9. [Review Agent](#9-review-agent)
10. [Service Contracts](#10-service-contracts)
11. [Configuration Files](#11-configuration-files)
12. [Environment Variables](#12-environment-variables)
13. [Agent Behaviour Rules](#13-agent-behaviour-rules)
14. [Generated Test Scaffold](#14-generated-test-scaffold)
15. [Error Handling](#15-error-handling)
16. [Claude Code Execution Checklist](#16-claude-code-execution-checklist)

---

## 1. Purpose & Scope

Phase 3 replaces the three stub handlers wired in Phase 2 (Webhook Listener) with real, production-ready logic. It is the **Claude Orchestrator** — the brain of KlikAgent.

**What Phase 3 owns:**
- Reading Jira tickets and parsing Acceptance Criteria
- **Skeleton Agent** (Flow 1) — interprets broad AC into concrete test cases using full `klikagent-tests` context
- **Enrichment Agent** (Flow 2) — grounds skeleton tests in real UI selectors via Playwright-CLI ARIA snapshot + full `klikagent-tests` context
- **Rework Flow** — handles `Rework` subtasks, patches parent spec surgically, inherits parent branch state
- **Review Agent** — responds to PR `CHANGES_REQUESTED` reviews as a batch, makes surgical fixes, re-requests review
- Committing generated files to `klikagent-tests`, opening PRs
- Checking CI status, reading PR diffs, triggering selective test runs
- Parsing test results and reporting back to Jira

**What Phase 3 does NOT do:**
- Receive webhooks — that is Phase 2
- Run tests — that happens in `klikagent-tests` via GitHub Actions
- Merge PRs — human reviews all generated test PRs
- Transition tickets autonomously — except the one agent-owned transition: `→ In QA`

---

## 2. Project Context

### 2.1 What is KlikAgent?
KlikAgent is an AI-powered QA automation platform that bridges Jira, GitHub, and a Playwright test repository. It watches Jira for status changes and automatically generates, commits, and reports on Playwright tests — all orchestrated by Claude.

### 2.2 Phase Dependencies

| Phase | Status | Description |
|---|---|---|
| Phase 1 | ✅ Done | `klikagent-tests` scaffold — Playwright + BDD + POM by feature |
| Phase 2 | ✅ Done | Webhook listener — receives Jira events, produces `TriggerContext` |
| **Phase 3** | **🔨 This** | **Claude Orchestrator — Flow 1, 2, 3 + Rework + Review Agent** |
| Phase 4 | 🔜 Next | Jira MCP integration polish |
| Phase 5 | 🔜 Next | GitHub integration polish |

### 2.3 Context Shapes

```typescript
// From Phase 2 webhook listener
interface TriggerContext {
  flow: 1 | 2 | 3;
  ticketId: string;                     // e.g. 'KA-42'
  ticketSummary: string;
  isRework: boolean;                    // true if issue type === 'Rework'
  parentTicketId?: string;              // populated when isRework === true
  runType?: 'new-tests' | 'affected' | 'smoke';  // Flow 2 → Flow 3 handoff
  buildId?: string;                     // GitHub Actions run ID (Flow 2)
  runId?: string;                       // GitHub Actions run ID (Flow 3)
  timestamp: string;
}

// From Phase 2 pull_request_review webhook handler
interface ReviewContext {
  prNumber: number;
  repo: string;                         // klikagent-tests
  branch: string;                       // qa/KA-42-slug
  ticketId: string;                     // extracted from branch name
  reviewId: number;
  reviewerLogin: string;                // re-request review from this user
  comments: ReviewComment[];
}

interface ReviewComment {
  id: number;
  path: string;                         // file the comment is on
  line: number;
  body: string;                         // what the reviewer said
  diffHunk: string;                     // surrounding code context
}
```

---

## 3. Design Decisions & Constraints

### 3.1 QA Environment
- Always running at fixed `QA_BASE_URL`
- No local dev server, no `webServer` in `playwright.config.ts`
- All crawls and test runs target this environment

### 3.2 Agent vs Service — The Deliberate Split

```
Deterministic TypeScript pipeline (orchestrator)
  └── Flow 1 ──────→ Skeleton Agent     (Claude + tools)
  └── Flow 2 ──────→ Enrichment Agent   (Claude + tools)
  └── Flow 2 (rework) → Rework Enrichment Agent (Claude + tools)
  └── Flow 3 ──────→ Result parser      (pure TypeScript)
  └── PR review ──→ Review Agent        (Claude + tools)
```

Outer flows are deterministic and auditable. Generation and review are agentic — Claude reasons, explores, and iterates.

### 3.3 Two-Phase Test Generation

| Flow | When | Agent | Output |
|---|---|---|---|
| Flow 1 | Ticket → In Progress | Skeleton Agent | Unrunnable spec — test names from AC, `throw new Error` bodies, no imports |
| Flow 2 | Ticket → Ready for QA (CI green) | Enrichment Agent | Runnable spec + POM — real selectors, proper imports |

No crawling in Flow 1. Feature is not built yet.

### 3.4 Full klikagent-tests Context

Both generation agents receive the full context of `klikagent-tests` before generating anything.

```
klikagent-tests/
├── pages/{feature}/*.ts        ← existing POMs
├── tests/web/{feature}/*.ts    ← existing specs (avoid duplicate coverage)
├── fixtures/index.ts           ← shared fixtures (authenticatedPage, etc.)
├── helpers/*.ts                ← shared utilities (fillForm, waitForToast, etc.)
├── data/*.ts                   ← test data constants (VALID_USER, PRODUCT_IDS, etc.)
├── config/routes.ts            ← route map
├── config/auth.ts              ← auth profiles
├── playwright.config.ts        ← baseURL, reporters
└── tsconfig.json               ← path aliases (@pages, @helpers, @data)
```

### 3.5 POM Strategy
- POM exists, has all methods → import and use, do not touch
- POM exists, missing methods → extend only, preserve all existing methods exactly
- POM does not exist → create from scratch
- All changes committed to same branch in one PR — human reviews together

### 3.6 Rework Strategy

When QA finds a bug, they create a `Rework` subtask manually. The subtask runs through the normal flow but with parent context awareness.

**Rework AC format:** Issues list + reproduction steps + expected vs actual behaviour

**Spec patching rules (surgical precision):**
- Unrelated existing tests → leave completely untouched
- Missing coverage the bug exposes → append new test cases
- Wrong assertion → update assertion only, add inline comment noting the change
- Wrong data/fixture → update reference only
- Fundamentally wrong test → add warning comment above, never delete or rewrite body
- Never delete any existing test case
- Never rewrite a test body wholesale

**Branch resolution:**
```
Rework subtask triggers
  │
  ├─ Find parent PR (branch: qa/{parentTicketId}-*)
  │
  ├─ Parent PR still OPEN
  │   └─ Commit to existing parent branch
  │   └─ Updates existing PR — rework visible in same review
  │
  └─ Parent PR MERGED or not found
      └─ Find existing rework branches for parent: qa/{parentId}-rework-*
      └─ N = count of existing rework branches + 1
      └─ Create new branch: qa/{parentId}-rework-{N}
      └─ Open new PR linked to parent ticket
```

### 3.7 Route Map & Feature Labels

**New Jira label: `feature:*`** alongside existing `scope:web / scope:api / scope:both`

| Label | Behaviour |
|---|---|
| `feature:{x}` | Single URL from route map |
| `feature:e2e` | AC-driven sequential multi-page crawl |
| *(no label)* | Infer from AC text via `featureDetector.ts` |

### 3.8 Auth Strategy
- Super/seed account for all crawls — `QA_USER_EMAIL` + `QA_USER_PASSWORD`
- Role-based crawling out of scope for Phase 3

### 3.9 Scope Guard + AC Guard

Flow 1 runs two sequential guards before any generation:

```
Flow 1 entry
  ├─ scope:none? → comment Jira + HALT (no QA needed — deliberate decision)
  ├─ scope:api only, no web? → comment Jira + HALT (no Playwright tests needed)
  ├─ AC missing? → comment Jira + HALT (ask reporter to add Given/When/Then)
  └─ Proceed
```

**scope:none comment:**
```
*[KlikAgent] Tests Skipped — scope:none*
This ticket is marked scope:none and does not require automated tests.
If this is incorrect, update the scope label and move the ticket back to In Progress.
```

**AC missing comment:**
```
*[KlikAgent] Tests Not Generated — Missing AC*
This ticket has no Acceptance Criteria in Given/When/Then format.
Please add AC and move the ticket back to In Progress to re-trigger.
```

**AC re-trigger convention (MVP):**
> If AC is added after the ticket is already `In Progress`, the team must manually move the ticket `To Do → In Progress` to re-trigger Flow 1. Phase 2 only listens for status transitions — not field updates. Listening for `issue_updated` description changes is a Phase 4 improvement.

### 3.10 Dev PR Convention (New Team Rule)
Dev branches must start with the ticket ID:
```
KA-42/short-description
KA-42-short-description
```

### 3.11 Flow 3 — Test Selection & Regression Levels

KlikAgent Phase 3 owns two levels of test runs. Full regression is owned by Phase 1.

| Level | Scope | Trigger | Workflow | Owner |
|---|---|---|---|---|
| Selective | New spec + affected tests from diff | Flow 2 dispatch | `selective.yml` | Phase 3 |
| Smoke | `@smoke` tagged tests across all features | Flow 2 dispatch (parallel) | `smoke.yml` | Phase 3 |
| Full regression | Entire test suite | Scheduled / manual dispatch | `regression.yml` | Phase 1 |

**Flow 2 dispatches both selective and smoke in parallel.** Both complete independently and each fires its own Flow 3 report via `workflow_run` webhook. `runType` identifies which report is which.

**`@smoke` tags are already configured in `klikagent-tests`.** Phase 3 does not manage or apply tags — it only triggers the `smoke.yml` workflow which runs `npx playwright test --grep @smoke` internally.

**Full regression** runs on a schedule defined in Phase 1. Phase 3 never triggers it.

### 3.12 Review Agent — MVP Scope
- Triggers on `pull_request_review` webhook: `action: submitted`, `state: CHANGES_REQUESTED` only
- Single reviewer assumption — no multi-reviewer conflict handling
- Applies to **enrichment and rework PRs only** — not skeleton/draft PRs
- Round limit: **3 rounds** — tracked by counting agent's own reply comment threads on the PR
- Round 4: agent stops, posts message on PR + Jira, does NOT re-request review
- Re-requests review from original reviewer (from webhook `reviewerLogin`)

### 3.13 Model
- Default: `claude-sonnet-4-20250514` via `CLAUDE_MODEL`
- All Claude services model-agnostic — model is a parameter

---

## 4. File Structure

```
src/
├── orchestrator/
│   ├── index.ts                        # Routes TriggerContext + ReviewContext
│   ├── flow1-ticket-to-active.ts       # Skeleton generation
│   ├── flow2-ticket-to-ready.ts        # CI gate + enrichment + dispatch
│   └── flow3-tests-complete.ts         # Results → Jira
│
├── agents/
│   ├── skeletonAgent.ts                # Flow 1 — skeleton generation
│   ├── enrichmentAgent.ts              # Flow 2 — spec enrichment + POM
│   ├── reworkAgent.ts                  # Rework — surgical spec patch + POM
│   ├── reviewAgent.ts                  # PR CHANGES_REQUESTED → fixes + re-request
│   └── tools/
│       ├── index.ts                    # Tool registry
│       ├── repoTools.ts                # klikagent-tests context tools
│       ├── githubTools.ts              # PR read/write tools (for Review Agent)
│       └── outputTools.ts             # done() tools
│
├── services/
│   ├── jira.ts                         # Jira MCP wrapper
│   ├── github.ts                       # GitHub REST API wrapper
│   ├── claude.ts                       # Generic runAgent() tool loop
│   ├── crawler.ts                      # Playwright-CLI: ARIA snapshot + reveal pass
│   └── testRepo.ts                     # klikagent-tests read/write
│
├── types/
│   └── index.ts                        # All shared interfaces
│
└── utils/
    ├── naming.ts                       # Branch slug + PR title
    ├── bdd.ts                          # AC parser + guard
    ├── routeResolver.ts                # feature:* → URL(s)
    ├── diffAnalyzer.ts                 # PR diff → affected test paths
    └── featureDetector.ts              # Infer feature from AC text
```

---

## 5. Flow Specifications

### 5.1 Flow 1 — Ticket Moved to In Progress

**Trigger:** Jira ticket → `In Progress` (isRework: false)
**Goal:** Skeleton Agent → commit unrunnable spec → open draft PR → comment Jira

> ⚠️ No crawling. Feature not built yet.

```
TriggerContext (flow === 1, isRework: false)
  │
  ├─ Read full Jira ticket via Jira MCP
  ├─ Parse AC — missing? → comment Jira + HALT
  ├─ Detect feature (label → featureDetector fallback)
  ├─ Run Skeleton Agent → skeleton spec
  ├─ Commit to branch: qa/{ticketId}-{slug}
  ├─ Open draft PR: "[KlikAgent] {ticketId}: {summary}"
  └─ Comment Jira: PR link + skeleton spec
```

| # | Step | Detail |
|---|---|---|
| 1 | Receive TriggerContext | `flow === 1`, `isRework: false` |
| 2 | Read Jira ticket | Summary, description, labels, AC |
| 3 | Parse AC | Halt + comment if missing |
| 4 | Detect feature | Label → fallback inference |
| 5 | Run Skeleton Agent | Full `klikagent-tests` context → skeleton spec |
| 6 | Commit skeleton | `qa/{ticketId}-{slug}` in `klikagent-tests` |
| 7 | Open draft PR | Body: "Skeleton — awaiting Flow 2 enrichment" |
| 8 | Comment Jira | PR link + skeleton code block |

**Jira Comment:**
```
*[KlikAgent] Test Skeleton Generated*
PR: {prUrl}
Branch: qa/{ticketId}-{slug}
Status: Skeleton — will be enriched with real selectors once build is green.

{{{skeletonSpecCode}}}
```

---

### 5.2 Flow 2 — Ticket Moved to Ready for QA

**Trigger:** Jira ticket → `Ready for QA` (isRework: false)
**Goal:** CI gate → Enrichment Agent → commit spec + POM → trigger selective tests

> ✅ Crawling happens here. Feature deployed to staging.

```
TriggerContext (flow === 2, isRework: false)
  │
  ├─ Fetch CI build status
  ├─ CI = RED → comment Jira + HALT
  └─ CI = GREEN
      ├─ Run Enrichment Agent
      │   └─ Full context + live crawl → enriched spec + POM
      ├─ Commit enriched files to qa/{ticketId}-{slug}
      │   ├─ tests/web/{feature}/{ticketId}.spec.ts
      │   └─ pages/{feature}/{Feature}Page.ts
      ├─ Find dev PR → fetch diff → analyze affected tests
      ├─ Determine runType
      ├─ Transition ticket → In QA (agent-owned)
      ├─ Dispatch test workflow
      └─ Comment Jira: enriched spec + POM status + run link
```

| # | Step | Detail |
|---|---|---|
| 1 | Receive TriggerContext | `flow === 2`, `isRework: false` |
| 2 | Fetch CI status | `GET /repos/{owner}/{GITHUB_MAIN_REPO}/actions/runs/{buildId}` |
| 3a | CI = red | Comment Jira. No transition. HALT. |
| 3b | CI = green | Proceed |
| 4 | Run Enrichment Agent | Skeleton + DOM snapshots + full context → enriched spec + POM |
| 5 | Commit enriched files | Spec + POM to `qa/{ticketId}-{slug}` |
| 6 | Find dev PR | GitHub Search: `{ticketId}` in branch/title |
| 7 | Fetch PR diff | Map changed `src/` → `tests/web/` folders |
| 8 | Determine selective runType | New spec → `new-tests` + affected; else `affected` |
| 9 | Transition ticket | `→ In QA` (dynamic transition lookup) |
| 10 | Dispatch selective.yml | `runType: new-tests/affected`, `specPath`, `affectedPaths` |
| 11 | Dispatch smoke.yml | In parallel — `runType: smoke`, `ticketId` |
| 12 | Comment Jira | Enriched spec + POM status + both run links |

**Workflow Dispatch — selective.yml:**
```json
{
  "ref": "main",
  "inputs": {
    "ticketId": "KA-42",
    "runType": "new-tests",
    "specPath": "tests/web/auth/KA-42.spec.ts",
    "affectedPaths": "tests/web/auth/,tests/web/checkout/"
  }
}
```

**Workflow Dispatch — smoke.yml (parallel):**
```json
{
  "ref": "main",
  "inputs": {
    "ticketId": "KA-42",
    "runType": "smoke"
  }
}
```

**Jira Comment — Red Build:**
```
*[KlikAgent] Build Failed — QA Blocked*
Build: {buildUrl}
Conclusion: FAILED

The ticket cannot move to In QA until the build is green.
Please fix the build and re-trigger.
```

**Jira Comment — Flow 2 Success:**
```
*[KlikAgent] Tests Enriched & Runs Triggered*
Branch: qa/{ticketId}-{slug}
PR: {prUrl}
Pages snapshotted: {snapshotUrls}
POM: {created | extended | unchanged}

Selective run ({runType}): {selectiveWorkflowUrl}
Smoke run: {smokeWorkflowUrl}

{{{enrichedSpecCode}}}
```

---

### 5.3 Flow 3 — Tests Complete

**Trigger:** `workflow_run` webhook when `klikagent-tests` CI completes
**Goal:** Parse JUnit XML → scoped summary → comment Jira (+ parent if rework)

```
TriggerContext (flow === 3)
  │
  ├─ Download JUnit XML artifact
  ├─ Parse: passed / failed / skipped per test name
  ├─ Scope by runType
  │   ├─ 'new-tests' → filter to {ticketId}.spec.ts only
  │   └─ 'affected'  → all spec files that ran
  ├─ Comment on ticket (subtask if rework)
  └─ If isRework + all tests pass
      └─ Post signal on parent ticket
```

| # | Step | Detail |
|---|---|---|
| 1 | Receive TriggerContext | `flow === 3`, `ticketId` + `runId` + `runType` |
| 2 | Download JUnit XML | Artifact `junit-results` from run |
| 3 | Parse results | Per-test-name granularity |
| 4 | Scope by runType | `new-tests`/`affected` → ticket spec files; `smoke` → all @smoke results |
| 5 | Comment ticket | Summary + run link. No transition. |
| 6 | Rework signal (if applicable) | Comment parent ticket if rework + all passed |

> **Two Flow 3 reports per Flow 2 trigger.** Selective and smoke run in parallel — each fires its own `workflow_run` webhook when complete. Phase 2 receives both independently and builds separate `TriggerContext` objects. The `runType` field distinguishes them.

**Jira Comment — Flow 3 (selective):**
```
*[KlikAgent] Selective Test Run Complete*
Run: {runUrl} | Type: {runType} | Ticket: {ticketId}

|| Result || Count ||
| ✅ Passed  | {passed}  |
| ❌ Failed  | {failed}  |
| ⏭ Skipped | {skipped} |

*Failed Tests:*
{failedTestNames — one per line, or 'None ✅'}

_Human review required before closing ticket._
```

**Jira Comment — Flow 3 (smoke):**
```
*[KlikAgent] Smoke Run Complete*
Run: {runUrl} | Ticket: {ticketId}

|| Result || Count ||
| ✅ Passed  | {passed}  |
| ❌ Failed  | {failed}  |
| ⏭ Skipped | {skipped} |

*Failed Smoke Tests:*
{failedTestNames — one per line, or 'None ✅'}

_Smoke failures may indicate a regression in existing happy path coverage._
```

**Parent ticket signal (rework, all passed):**
```
*[KlikAgent] Rework Complete — {subtaskId}*
Subtask: {subtaskUrl}
Result: All tests passed ✅
PR: {reworkPrUrl}

Ready for re-review. Human decision required to close.
```

---

## 6. Rework Flow

### 6.1 Overview

When QA finds a bug, they manually create a `Rework` subtask linked to the parent ticket. The subtask has its own Jira lifecycle and triggers the normal Flow 1 → 2 → 3 sequence, but with parent-aware behaviour at every step.

```
QA finds bug in In QA ticket
  → QA creates Rework subtask manually
      Summary: short bug description
      Description: issues list + reproduction steps + expected vs actual behaviour
      Type: Rework
      Parent: KA-42
  → Subtask moves to In Progress → Flow 1 (Rework Skeleton)
  → Subtask moves to Ready for QA → Flow 2 (Rework Enrichment)
  → Tests complete → Flow 3 (results + parent signal)
```

### 6.2 How Phase 2 Detects a Rework

Phase 2 webhook listener reads the Jira issue type from the event payload:
```typescript
isRework: event.issue.fields.issuetype.name === 'Rework'
parentTicketId: event.issue.fields.parent?.key ?? undefined
```

Both are passed in `TriggerContext`.

### 6.3 Flow 1 — Rework Skeleton

**Trigger:** Rework subtask → `In Progress`

Same as normal Flow 1 with two differences:
1. Skeleton Agent receives parent ticket context + rework description (issues + reproduction + expected/actual)
2. Skeleton generates test cases that cover the specific bugs described — not broad AC interpretation

```
TriggerContext (flow === 1, isRework: true, parentTicketId: 'KA-42')
  │
  ├─ Read rework subtask (issues, reproduction steps, expected/actual)
  ├─ Read parent ticket (original AC, feature label)
  ├─ Detect feature from parent ticket
  ├─ Run Skeleton Agent (rework mode)
  │   └─ Context: parent spec + rework description + full klikagent-tests context
  │   └─ Output: skeleton test cases covering the specific bugs
  ├─ Resolve branch (see 6.4)
  ├─ Commit skeleton (append to parent spec OR new file on rework branch)
  ├─ Open PR if new branch (rework branch), or update existing PR comment if parent branch
  └─ Comment subtask Jira: PR link + skeleton
```

### 6.4 Branch Resolution

```typescript
async function resolveReworkBranch(parentTicketId: string): Promise<{
  branch: string;
  isExistingBranch: boolean;
  prNumber: number | null;
}> {
  // 1. Find parent PR
  const parentPR = await github.findPRByTicketId(parentTicketId, GITHUB_TEST_REPO);

  if (parentPR && parentPR.state === 'open') {
    // Commit to existing parent branch
    return { branch: parentPR.head.ref, isExistingBranch: true, prNumber: parentPR.number };
  }

  // 2. Parent PR merged or not found — find existing rework branches
  const existingReworks = await github.findBranchesByPattern(
    GITHUB_TEST_REPO,
    `qa/${parentTicketId}-rework-`
  );
  const N = existingReworks.length + 1;
  const branch = `qa/${parentTicketId}-rework-${N}`;

  return { branch, isExistingBranch: false, prNumber: null };
}
```

### 6.5 Flow 2 — Rework Enrichment

**Trigger:** Rework subtask → `Ready for QA` (CI green)

Same CI gate as normal Flow 2. Enrichment Agent runs in **rework mode** — surgical patch instead of full generation.

```
TriggerContext (flow === 2, isRework: true, parentTicketId: 'KA-42')
  │
  ├─ Fetch CI build status — red? → comment subtask + HALT
  └─ CI = GREEN
      ├─ Run Rework Enrichment Agent
      │   ├─ Loads full klikagent-tests context
      │   ├─ Loads parent spec (from branch or main)
      │   ├─ Loads rework description (issues + repro + expected/actual)
      │   ├─ Crawls affected pages
      │   ├─ Reasons per existing test: untouched / append / update assertion / flag
      │   └─ Calls done(patchedSpec, pomContent)
      ├─ Commit patched files to resolved branch
      ├─ Open new PR (if rework branch) or update existing PR comment (if parent branch)
      ├─ Dispatch test workflow (runType: 'new-tests' scoped to new test cases only)
      └─ Comment subtask + parent: rework enrichment complete + run link
```

### 6.6 Spec Patch Rules (enforced by Rework Enrichment Agent)

| Existing test situation | Agent action |
|---|---|
| Unrelated to bug description | Leave completely untouched |
| Missing coverage bug exposes | Append new test case after existing tests |
| Wrong assertion | Update assertion only + add inline comment |
| Wrong data or fixture reference | Update reference only + add inline comment |
| Fundamentally wrong test body | Add warning comment above, do not modify body |
| Any test | Never delete, never rewrite wholesale |

**Warning comment format:**
```typescript
// ⚠️ [KlikAgent {subtaskId}] This test may be incorrect based on rework description.
// Bug: "{one-line bug summary from rework description}"
// Human review required — do not merge without verifying this test's intent.
test('Given valid credentials When user logs in Then dashboard is shown', ...)
```

**Inline change comment format:**
```typescript
// [KlikAgent {subtaskId}] Updated assertion — bug: "{one-line summary}"
await expect(page).toHaveURL('/verify-email'); // was: '/dashboard'
```

### 6.7 Multiple Rework Cycles

If a second bug is found after the first rework:
- QA creates another `Rework` subtask (`KA-42-2`)
- Agent finds `qa/KA-42-rework-1` already exists → creates `qa/KA-42-rework-2`
- Each rework cycle is isolated to its own branch and PR
- Parent ticket accumulates comments from each rework cycle's Flow 3 signal

---

## 7. Page Snapshot System

> **Enrichment Agent and Rework Enrichment Agent (Flow 2) only.**
> Playwright-CLI based — lightweight, bounded token consumption, predictable cost.

### 7.1 Why Playwright-CLI over playwright-mcp

With playwright-mcp, Claude drives the browser interactively — calling `browser_snapshot()` multiple times per page, potentially consuming 50k+ tokens per Flow 2 run. With playwright-CLI, a targeted Node script runs once, extracts exactly what's needed, and passes a compact payload to Claude once. Token consumption is bounded and predictable.

The tradeoff: Claude cannot adaptively request more exploration. This is acceptable for KlikAgent because the AC and route map already define which flows to test — we're not exploring blindly.

### 7.2 How It Works

```
Flow 2 CI = green
  → resolve target URL(s) from feature label + route map
  → run crawler.ts script (Playwright headless, Node)
  → authenticate with super user session
  → navigate to target URL
  → waitForLoadState('networkidle')
  → standard reveal pass (expose common dynamic elements)
  → page.accessibility.snapshot() → compact ARIA tree
  → supplement with data-testid elements not in ARIA tree
  → serialize to PageSnapshot
  → pass once to Enrichment Agent
```

### 7.3 PageSnapshot Shape

Uses Playwright's built-in accessibility API — returns role-based ARIA structure, not raw HTML. Much more signal-dense and token-efficient than raw DOM extraction.

```typescript
interface PageSnapshot {
  url: string;
  title: string;

  // ARIA tree from page.accessibility.snapshot()
  // Role-based: button, textbox, link, checkbox, combobox, etc.
  // Includes name (label), value, checked state, disabled state
  ariaTree: AriaNode;

  // Supplement: data-testid elements (often missing from ARIA tree)
  testIds: {
    testId: string;
    tag: string;
    selector: string;        // [data-testid="{testId}"]
    visible: boolean;
  }[];

  // Navigation links — for E2E flow understanding
  navigationLinks: {
    text: string;
    href: string;
  }[];
}

// Playwright's native AriaNode shape (from page.accessibility.snapshot())
interface AriaNode {
  role: string;              // button, textbox, link, heading, etc.
  name?: string;             // accessible name (label text, aria-label, placeholder)
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  children?: AriaNode[];
}
```

### 7.4 Selector Strategy

The Enrichment Agent receives the `PageSnapshot` and derives selectors in this priority order. Claude applies this reasoning — the snapshot provides the data, Claude decides the selector:

1. `data-testid` (from `testIds[]`) → `[data-testid="login-btn"]` — most stable
2. ARIA role + name → `page.getByRole('button', { name: 'Login' })` — semantic, resilient
3. ARIA label → `page.getByLabel('Email address')` — form field standard
4. ARIA placeholder → `page.getByPlaceholder('Enter email')`
5. Visible text → `page.getByText('Forgot password?')` — links and static text
6. CSS fallback (last resort, flagged in comment) → `page.locator('#email-input')`

> **Playwright locator API is preferred over raw CSS selectors.** The generated POM should use `page.getByRole()`, `page.getByLabel()`, `page.getByTestId()` — not `page.locator('[name=email]')` — unless no semantic alternative exists.

### 7.5 Standard Reveal Pass

Before calling `page.accessibility.snapshot()`, the crawler runs a standard reveal pass to expose common dynamic elements that only appear after interaction. This is a fixed script — Claude does not drive it.

```typescript
async function revealDynamicContent(page: Page): Promise<void> {
  // Expand collapsed accordions and disclosure widgets
  const collapsed = page.locator('[aria-expanded="false"]');
  for (const el of await collapsed.all()) {
    await el.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Hover over elements that reveal tooltips or sub-menus
  const triggers = page.locator('[data-toggle], [aria-haspopup="true"]');
  for (const el of await triggers.all()) {
    await el.hover().catch(() => {});
    await page.waitForTimeout(200);
  }

  // Wait for any animations to settle
  await page.waitForLoadState('networkidle').catch(() => {});
}
```

> **Modals triggered by button clicks are not auto-revealed.** Clicking navigation buttons could change page state. If an AC test case requires a modal interaction, the Enrichment Agent notes it in a `// TODO: modal — trigger with [selector]` comment in the generated test, and the human reviewer fills in the modal selectors during PR review.

### 7.6 Multi-Page Snapshot (E2E tickets)

When `feature:e2e` label is present, the crawler produces one `PageSnapshot` per page in AC sequence:

```typescript
async function capturePages(urls: string[]): Promise<PageSnapshot[]> {
  const browser = await chromium.launch();
  const page = await getAuthenticatedPage(browser);
  const snapshots: PageSnapshot[] = [];

  for (const url of urls) {
    await page.goto(`${process.env.QA_BASE_URL}${url}`);
    await page.waitForLoadState('networkidle');
    await revealDynamicContent(page);
    snapshots.push(await extractSnapshot(page, url));
  }

  await browser.close();
  return snapshots;
}
```

The session persists across pages — authenticated once, navigates across the whole E2E flow.

### 7.7 Auth Flow

```typescript
async function getAuthenticatedPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${process.env.QA_BASE_URL}/login`);
  await page.fill('[name=email]', process.env.QA_USER_EMAIL!);
  await page.fill('[name=password]', process.env.QA_USER_PASSWORD!);
  await page.click('button[type=submit]');
  await page.waitForNavigation();
  return page; // session persists for subsequent navigations
}
```

### 7.8 Token Budget

Rough estimates per Flow 2 run:

| Component | Approx tokens |
|---|---|
| Single PageSnapshot (ARIA tree + testIds) | ~800–2,000 |
| Multi-page E2E (3 pages) | ~3,000–6,000 |
| Full klikagent-tests context (POMs + fixtures + helpers) | ~3,000–5,000 |
| Skeleton spec | ~500–1,000 |
| **Total per Flow 2 run** | **~5,000–12,000** |

Bounded and predictable. Compare to playwright-mcp which could be 50k+ for a complex page with multiple snapshot calls.

---

## 8. Test Generation Agents

### 8.1 Agent Tool Loop

```typescript
async function runAgent(
  systemPrompt: string,
  userMessage: string,
  tools: Tool[],
  toolHandlers: Record<string, ToolHandler>,
  options: AgentRunOptions = {}
): Promise<Record<string, unknown>> {
  const { maxIterations = 20 } = options;
  const messages = [{ role: 'user', content: userMessage }];
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;
    const response = await callClaude({ system: systemPrompt, messages, tools });

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'done') return block.input;
        const result = await toolHandlers[block.name](block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  throw new Error(`Agent did not call done() within ${maxIterations} iterations`);
}
```

---

### 8.2 Skeleton Agent (Flow 1)

**Job:** Interpret broad AC into concrete, non-redundant test cases. No selectors. No imports.

#### System Prompt
```
You are a senior QA automation engineer on the klikagent-tests Playwright suite.
Generate a skeleton test spec from a Jira ticket's Acceptance Criteria.

Use tools to load context before generating. Do not guess — always check what exists.

Skeleton rules:
- Derive test names from AC using Given/When/Then
- One describe block: test.describe('{ticketId}: {summary}')
- Every test body: throw new Error('Not implemented — awaiting Flow 2 enrichment')
- NO imports, NO selectors, NO page object references
- Cover: happy path, edge cases, negative tests
- Do NOT duplicate scenarios already in existing specs for this feature
- Use the route map to interpret broad AC — understand what pages exist

Call done(skeletonSpec) when ready.
```

#### Tools
```
get_route_map()
get_existing_pom_names({ feature })
get_existing_tests({ feature })          ← avoid duplicate coverage
get_tsconfig()
done({ skeletonSpec: string })
```

#### Rework Mode (Flow 1 with isRework: true)

Same tools, different system prompt addition:
```
You are generating a REWORK skeleton — not interpreting broad AC.
The rework description contains specific bugs, reproduction steps, and expected vs actual behaviour.
Generate test cases that directly cover the reported bugs.
Also load the parent spec to understand what is already tested — do not duplicate.

Additional tool available:
get_parent_spec({ parentTicketId, feature })   ← load parent spec for context
```

---

### 8.3 Enrichment Agent (Flow 2)

**Job:** Replace skeleton bodies with real interactions grounded in live DOM. Create or extend POMs. Use existing fixtures, helpers, test data.

#### System Prompt
```
You are a senior QA automation engineer on the klikagent-tests Playwright suite.
Enrich a skeleton Playwright spec with real selectors and interactions.
Create or extend the Page Object Model (POM).

Load full klikagent-tests context first — always check before generating.
A PageSnapshot (ARIA tree + testIds) is provided for each target page — already captured
by the crawler before this agent runs. Use it to derive selectors.

Selector preference order: getByTestId → getByRole → getByLabel → getByPlaceholder → getByText → locator (last resort).
Always use Playwright locator API — not raw CSS selectors — unless no semantic alternative exists.

If a test case requires a modal or element not visible in the snapshot, add:
// TODO: modal — trigger with [describe the trigger] and capture additional selectors
Do not block generation — note it and move on.

Rules:
- Use ONLY selectors from DOM snapshots — never invent
- All selectors live in POM — never inline in spec
- Use existing fixtures instead of writing login boilerplate
- Use existing helpers instead of repetitive inline code
- Import test data from @data instead of hardcoding values
- Use correct import aliases from tsconfig
- If POM exists: extend only, preserve all existing methods exactly
- If POM does not exist: create from scratch
- Replace every throw new Error(...) with real interactions
- Keep all Given/When/Then test names exactly as in skeleton
- Never hardcode URLs

Validate TypeScript before calling done(). Fix any errors found.
Call done(enrichedSpec, pomContent) when ready.
```

#### Tools
```
// Context
get_skeleton_spec({ branch, ticketId, feature })
get_existing_pom({ feature })
get_fixtures()
get_helpers()
get_test_data()
get_tsconfig()
get_playwright_config()

// Page snapshot — already captured before agent runs, passed as input
// Agent receives PageSnapshot[] directly in the user message — no tool call needed

// Output
validate_typescript({ code })
done({ enrichedSpec: string, pomContent: string })
```

---

### 8.4 Rework Enrichment Agent (Flow 2 with isRework: true)

**Job:** Surgically patch parent spec based on bug description. Never delete. Never rewrite wholesale.

#### System Prompt
```
You are a senior QA automation engineer handling a Rework subtask.
Your job is to surgically patch the parent spec — not regenerate it.

Load the parent spec and the rework description first.
For EACH existing test, reason about whether the bug affects it:

- Unrelated to bug → leave completely untouched
- Missing coverage → append new test case after existing tests
- Wrong assertion → update assertion only, add inline change comment
- Wrong data/fixture → update reference only, add inline change comment
- Fundamentally wrong → add warning comment above, do not modify body

Never delete any test case.
Never rewrite a test body wholesale.
Minimal, surgical changes only.

Also load full klikagent-tests context — use existing helpers, fixtures, test data.
A PageSnapshot is provided in the user message for any pages referenced in the rework description.
Use it to derive selectors for new test cases you append.
Validate TypeScript before calling done().

Call done(patchedSpec, pomContent) when ready.
```

#### Tools
```
// Context
get_parent_spec({ parentTicketId, feature, branch })
get_rework_description({ subtaskId })
get_existing_pom({ feature })
get_fixtures()
get_helpers()
get_test_data()
get_tsconfig()
get_playwright_config()

// Page snapshot for new test cases — passed as input in user message
// Crawler runs before agent for any URLs referenced in rework description

// Output
validate_typescript({ code })
done({ patchedSpec: string, pomContent: string })
```

---

## 9. Review Agent

### 9.1 Trigger

Phase 2 receives `pull_request_review` webhook:
- `action: submitted`
- `state: CHANGES_REQUESTED`
- PR branch starts with `qa/` (KlikAgent-owned PR)
- PR is NOT a draft (skeleton PRs are draft — excluded)

Phase 2 builds `ReviewContext` and routes to Review Agent.

### 9.2 Round Limit

The agent counts its own reply comment threads on the PR to determine the current round:

```typescript
async function getCurrentReviewRound(prNumber: number, repo: string): Promise<number> {
  const comments = await github.getPRComments(prNumber, repo);
  const agentReplies = comments.filter(c =>
    c.user.login === 'klikagent[bot]' &&
    c.body.startsWith('[KlikAgent] Fixed:')
  );
  // Each round = one batch of replies (one per reviewer comment)
  // Count distinct review rounds by grouping reply timestamps
  return countDistinctRounds(agentReplies);
}
```

If `currentRound >= 3` before processing:
- Post PR comment: "Maximum review rounds (3) reached. Human resolution required."
- Comment Jira: same message + PR link
- Return — do NOT re-request review

### 9.3 Agent Flow

```
ReviewContext received
  │
  ├─ Check round limit → at limit? → post messages + HALT
  │
  ├─ Run Review Agent
  │   ├─ Read all comments from submitted review (as a batch)
  │   ├─ Read current spec + POM from branch
  │   ├─ Read full klikagent-tests context
  │   ├─ Reason about all comments together
  │   ├─ Make surgical fixes
  │   ├─ Validate TypeScript
  │   └─ Call done(fixes)
  │
  ├─ Commit fixes to same branch
  ├─ Reply to each reviewer comment thread
  ├─ Re-request review from original reviewer
  └─ Comment Jira: "PR review round {N} addressed, re-review requested from @{reviewer}"
```

### 9.4 System Prompt

```
You are a senior QA automation engineer responding to a PR review on klikagent-tests.
A QA engineer has submitted a CHANGES_REQUESTED review with inline comments.
Address ALL comments as a batch — reason about them together before making any changes.

Rules:
- Read all comments before deciding on any fix
- Make minimal, surgical changes — only what the comment requests
- If a comment is ambiguous, implement the most conservative interpretation
- If a comment requests something that would break other tests, do not implement it —
  instead reply explaining why and ask for clarification
- If a comment is not actionable (e.g. a question about AC), reply noting it has been
  passed to the Jira ticket for human decision — do not modify code
- Never delete existing passing tests
- Validate TypeScript after all fixes before calling done()

For each comment, produce a reply: "[KlikAgent] Fixed: {brief explanation of what changed}"
Or if not actionable: "[KlikAgent] Noted: {explanation} — flagged on Jira ticket."

Call done(fixedSpec, pomContent, commentReplies) when ready.
```

### 9.5 Tools

```
// Read current state
get_current_spec({ branch, feature, ticketId })
get_current_pom({ branch, feature })
get_full_review_comments({ prNumber, reviewId })

// Context
get_fixtures()
get_helpers()
get_test_data()
get_tsconfig()

// Output
validate_typescript({ code })
done({
  fixedSpec: string,
  pomContent: string,
  commentReplies: { commentId: number, body: string }[]
})
```

### 9.6 After Agent Completes

```typescript
// 1. Commit fixes
await github.commitFile(repo, branch, specPath, fixedSpec, `fix: review round ${N} — ${ticketId}`);
if (pomContent) await github.commitFile(repo, branch, pomPath, pomContent, `fix: POM update — ${ticketId}`);

// 2. Reply to each comment thread
for (const reply of commentReplies) {
  await github.replyToReviewComment(prNumber, repo, reply.commentId, reply.body);
}

// 3. Re-request review from original reviewer
await github.requestReview(prNumber, repo, reviewerLogin);

// 4. Comment on Jira
await jira.commentOnTicket(ticketId,
  `*[KlikAgent] PR Review Round ${N} Addressed*\n` +
  `PR: ${prUrl}\n` +
  `Re-review requested from @${reviewerLogin}\n` +
  `${commentReplies.length} comment(s) addressed.`
);
```

---

## 10. Service Contracts

### 10.1 Jira Service (`src/services/jira.ts`)

```typescript
interface JiraTicket {
  id: string;
  summary: string;
  description: string;
  status: string;
  labels: string[];
  issueType: string;                    // 'Story' | 'Rework' | etc.
  parentKey?: string;                   // populated for subtasks
  acceptanceCriteria: string;
}

getTicket(ticketId: string): Promise<JiraTicket>
commentOnTicket(ticketId: string, body: string): Promise<void>
getAvailableTransitions(ticketId: string): Promise<{ id: string; name: string }[]>
transitionTicket(ticketId: string, targetStatus: string): Promise<void>
```

### 10.2 GitHub Service (`src/services/github.ts`)

```typescript
// CI
getCIStatus(runId: string, repo: string): Promise<CIResult>

// PR
findPRByTicketId(ticketId: string, repo: string): Promise<PR | null>
findBranchesByPattern(repo: string, pattern: string): Promise<string[]>
getPRDiff(prNumber: number, repo: string): Promise<ChangedFile[]>
getPRComments(prNumber: number, repo: string): Promise<PRComment[]>
replyToReviewComment(prNumber: number, repo: string, commentId: number, body: string): Promise<void>
requestReview(prNumber: number, repo: string, reviewer: string): Promise<void>

// Branch + commits
getDefaultBranchSha(repo: string): Promise<string>
createBranch(repo: string, branchName: string, baseSha: string): Promise<void>
commitFile(repo: string, branch: string, path: string, content: string, message: string): Promise<void>
getFileOnBranch(repo: string, branch: string, path: string): Promise<string | null>

// PRs
openPR(repo: string, branch: string, title: string, body: string, draft?: boolean): Promise<string>

// Workflow
triggerWorkflow(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void>

// Artifacts
downloadArtifact(repo: string, runId: string, artifactName: string): Promise<string>
```

### 10.3 Claude Service (`src/services/claude.ts`)

```typescript
interface AgentRunOptions {
  model?: string;
  maxTokens?: number;     // default 8192
  maxIterations?: number; // default 20
}

runAgent(
  systemPrompt: string,
  userMessage: string,
  tools: Tool[],
  toolHandlers: Record<string, ToolHandler>,
  options?: AgentRunOptions
): Promise<Record<string, unknown>>
```

### 10.4 Crawler Service (`src/services/crawler.ts`)

Playwright-CLI based. Runs before the Enrichment/Rework Agent — not called by agent tools directly. Orchestrator calls it, passes resulting `PageSnapshot[]` to the agent in the user message.

```typescript
// Single page
captureSnapshot(url: string): Promise<PageSnapshot>

// Multi-page — E2E tickets (feature:e2e)
captureSnapshots(urls: string[]): Promise<PageSnapshot[]>

// Internal
getAuthenticatedPage(browser: Browser): Promise<Page>
revealDynamicContent(page: Page): Promise<void>
extractSnapshot(page: Page, url: string): Promise<PageSnapshot>
extractTestIds(page: Page): Promise<PageSnapshot['testIds']>
```

### 10.5 Test Repo Service (`src/services/testRepo.ts`)

```typescript
// Shared context — both agents
getRouteMap(): Promise<string>
getTsConfig(): Promise<string>
getPlaywrightConfig(): Promise<string>

// Skeleton Agent
getExistingPOMNames(feature: string): Promise<string[]>
getExistingTests(feature: string): Promise<Record<string, string>>

// Enrichment + Review Agent
getSkeletonSpec(branch: string, ticketId: string, feature: string): Promise<string>
getExistingPOM(feature: string): Promise<string | null>
getFixtures(): Promise<string>
getHelpers(): Promise<Record<string, string>>
getTestData(): Promise<Record<string, string>>

// Rework Agent
getParentSpec(branch: string, parentTicketId: string, feature: string): Promise<string>

// Review Agent
getCurrentSpec(branch: string, ticketId: string, feature: string): Promise<string>
getCurrentPOM(branch: string, feature: string): Promise<string | null>

// Write
commitFile(branch: string, path: string, content: string, message: string): Promise<void>
```

### 10.6 Agents

```typescript
// src/agents/skeletonAgent.ts
runSkeletonAgent(ticket: JiraTicket, feature: string, isRework: boolean): Promise<string>

// src/agents/enrichmentAgent.ts
runEnrichmentAgent(
  ticket: JiraTicket,
  feature: string,
  branch: string,
  snapshots: PageSnapshot[]             // captured by crawler before agent runs
): Promise<{
  enrichedSpec: string;
  pomContent: string;
}>

// src/agents/reworkAgent.ts
runReworkAgent(
  subtask: JiraTicket,
  parentTicket: JiraTicket,
  feature: string,
  branch: string,
  snapshots: PageSnapshot[]             // captured for pages referenced in rework description
): Promise<{
  patchedSpec: string;
  pomContent: string;
}>

// src/agents/reviewAgent.ts
runReviewAgent(ctx: ReviewContext, feature: string): Promise<{
  fixedSpec: string;
  pomContent: string;
  commentReplies: { commentId: number; body: string }[];
}>
```

---

## 11. Configuration Files

### 11.1 Route Map — `klikagent-tests/config/routes.ts`
```typescript
export const routes: Record<string, string> = {
  auth:      '/login',
  checkout:  '/cart',
  search:    '/search',
  profile:   '/account/profile',
  dashboard: '/',
};
```

### 11.2 Auth Profiles — `klikagent-tests/config/auth.ts`
```typescript
export const authProfiles = {
  super: {
    email:    process.env.QA_USER_EMAIL!,
    password: process.env.QA_USER_PASSWORD!,
  },
};
```

### 11.3 playwright.config.ts — Required Changes
```typescript
export default defineConfig({
  testDir: './tests',
  use: { baseURL: process.env.QA_BASE_URL },
  reporter: [
    ['html'],
    ['junit', { outputFile: 'results/junit.xml' }],
  ],
});
```

**Required CI step:**
```yaml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: junit-results
    path: results/junit.xml
```

---

## 12. Environment Variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API authentication |
| `CLAUDE_MODEL` | Default `claude-sonnet-4-20250514` |
| `JIRA_BASE_URL` | e.g. `https://yourorg.atlassian.net` |
| `JIRA_USER_EMAIL` | Jira API user email |
| `JIRA_API_TOKEN` | Jira API token |
| `GITHUB_TOKEN` | PAT with `repo` + `workflow` scopes |
| `GITHUB_OWNER` | GitHub org or user owning both repos |
| `GITHUB_TEST_REPO` | `klikagent-tests` |
| `GITHUB_MAIN_REPO` | Main app repo |
| `QA_BASE_URL` | e.g. `https://qa.yourapp.com` |
| `QA_USER_EMAIL` | Super/seed QA account email |
| `QA_USER_PASSWORD` | Super/seed QA account password |

---

## 13. Agent Behaviour Rules

| Rule | Detail |
|---|---|
| **scope:none or scope:api → halt** | No Playwright tests needed. Comment Jira + return immediately in Flow 1. |
| **Never generate without AC** | AC missing → comment Jira + halt |
| **Never crawl in Flow 1** | Crawler is Flow 2 only |
| **Never invent selectors** | Only selectors from DOM snapshots |
| **Always load full repo context first** | Both agents call repo tools before generating |
| **Never remove existing tests** | Rework patches only — never deletes |
| **Never rewrite test bodies wholesale** | Rework: surgical changes only |
| **Never auto-transition** (except one) | Only `→ In QA` is agent-owned |
| **Never commit to main** | Always `qa/{ticketId}-{slug}` branch |
| **Never merge PRs** | Open PR only, human reviews |
| **Always validate TypeScript** | Enrichment + Rework + Review agents must call `validate_typescript` before `done()` |
| **Always comment before action** | Post intent to Jira before committing or triggering |
| **Always look up transition IDs** | Never hardcode — fetch dynamically |
| **Cap agent iterations** | `maxIterations: 20` — error + comment Jira if hit |
| **Cap review rounds** | 3 rounds max — post message + step back on round 4 |
| **Review: process comments as batch** | Wait for full review submission, not individual comments |
| **Graceful errors** | Catch all failures, log structured JSON, comment Jira, return |

---

## 14. Generated Test Scaffold

### 14.1 File Placement
```
klikagent-tests/
├── tests/web/{feature}/{ticketId}.spec.ts    ← skeleton (Flow 1) / enriched (Flow 2)
└── pages/{feature}/{Feature}Page.ts          ← created or extended (Flow 2)
```

### 14.2 Feature Detection Priority
1. `feature:*` Jira label
2. Keyword inference via `featureDetector.ts`
3. Default: `general`

### 14.3 Branch Naming
| Scenario | Branch |
|---|---|
| Normal flow | `qa/{ticketId}-{slug}` |
| Rework, parent PR open | Existing parent branch |
| Rework, parent PR merged | `qa/{parentTicketId}-rework-{N}` |

### 14.4 PR Title & Body
```
Title: [KlikAgent] {ticketId}: {ticketSummary}

Body:
Jira: {jiraTicketUrl}
Feature: {featureLabel}
Status: Skeleton | Enriched | Rework-{N}
Parent: {parentTicketUrl} (rework only)

Auto-generated by KlikAgent. Human review required before merge.
```

---

## 15. Error Handling

### 15.1 General Policy
All external calls wrapped in try/catch:
1. Log `{ service, flow, ticketId, step, error: error.message }`
2. Comment on Jira with step + error
3. Return gracefully — never crash Phase 2

### 15.2 Error Comments

**Agent hit maxIterations:**
```
*[KlikAgent] Agent Loop Limit Reached*
Flow: {flow} | Ticket: {ticketId} | Iterations: 20
The agent could not complete. Manual test writing may be needed.
```

**Skeleton generation failed:**
```
*[KlikAgent] Skeleton Generation Failed*
Step: {step} | Error: {message}
Re-trigger by moving ticket back to In Progress.
```

**Crawl failed:**
```
*[KlikAgent] Page Crawl Failed*
URL: {url} | Error: {message}
Page may not be deployed. Re-trigger once staging is confirmed up.
```

**TypeScript validation failed:**
```
*[KlikAgent] Generated Code Failed Validation*
Errors: {tscErrors}
Manual review of branch required.
```

**Review round limit reached:**
```
*[KlikAgent] Maximum Review Rounds (3) Reached*
PR: {prUrl}
Human resolution required. Agent has stepped back.
```

**Flow 3 parse failed:**
```
*[KlikAgent] Result Parsing Failed*
Run: {runUrl} | Error: {message}
Check the GitHub Actions run directly.
```

### 15.3 Retry Policy
No automatic flow retries. Agents may loop internally up to `maxIterations`. On terminal failure: comment Jira → log → return.

---

## 16. Claude Code Execution Checklist

Work through in order. Each item = a separate commit.

- [ ] `src/types/index.ts` — all interfaces: `TriggerContext`, `ReviewContext`, `ReviewComment`, `JiraTicket`, `PageSnapshot`, `AriaNode`, `CIResult`, `PR`, `ChangedFile`, `PRComment`, `AgentResult`, `Tool`, `ToolHandler`
- [ ] `src/utils/naming.ts` — branch slug + PR title formatters
- [ ] `src/utils/bdd.ts` — AC parser + `hasAcceptanceCriteria()` guard
- [ ] `src/utils/featureDetector.ts` — keyword inference from AC
- [ ] `src/utils/routeResolver.ts` — `feature:*` → URL(s), `feature:e2e` AC-driven
- [ ] `src/utils/diffAnalyzer.ts` — changed `src/` → `tests/web/` folders
- [ ] `src/services/jira.ts` — Jira MCP wrapper
- [ ] `src/services/github.ts` — GitHub REST: CI, PR, branch, commit, review, workflow, artifacts
- [ ] `src/services/crawler.ts` — Playwright-CLI: auth, reveal pass, `page.accessibility.snapshot()`, `PageSnapshot` builder
- [ ] `src/services/testRepo.ts` — full `klikagent-tests` context reader + writer
- [ ] `src/services/claude.ts` — generic `runAgent()` tool loop
- [ ] `src/agents/tools/repoTools.ts` — all `testRepo` context tool definitions + handlers
- [ ] `src/agents/tools/githubTools.ts` — PR read/write tool definitions + handlers (Review Agent)
- [ ] `src/agents/tools/outputTools.ts` — `done()` tool definitions for all agents
- [ ] `src/agents/tools/index.ts` — tool registry
- [ ] `src/agents/skeletonAgent.ts` — normal + rework mode
- [ ] `src/agents/enrichmentAgent.ts`
- [ ] `src/agents/reworkAgent.ts`
- [ ] `src/agents/reviewAgent.ts`
- [ ] `src/orchestrator/flow1-ticket-to-active.ts` — scope guard + AC guard + normal/rework branch
- [ ] `src/orchestrator/flow2-ticket-to-ready.ts` — CI gate + enrichment + parallel selective + smoke dispatch
- [ ] `src/orchestrator/flow3-tests-complete.ts` — selective/smoke/rework runType branching + parent signal
- [ ] `src/orchestrator/index.ts` — routes `TriggerContext` + `ReviewContext`
- [ ] Wire Phase 2 stubs → `src/orchestrator/index.ts`
- [ ] Wire Phase 2 `pull_request_review` webhook → `ReviewContext` → `orchestrator/index.ts`
- [ ] `klikagent-tests/config/routes.ts`
- [ ] `klikagent-tests/config/auth.ts`
- [ ] `klikagent-tests/playwright.config.ts` — JUnit reporter + `if: always()` artifact
- [ ] `.env.example` — all vars documented

---

*KlikAgent — Build in Public*
*Phase 3 Requirements v2.5 — For Claude Code execution*
*Stack: TypeScript | Playwright | Jira MCP | GitHub Actions | Claude API (Agentic)*
