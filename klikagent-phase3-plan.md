# KlikAgent Phase 3 — Implementation Plan

## Overview

Phase 3 replaces the Phase 2 stub handlers with real orchestration logic. It is the Claude Orchestrator — reading Jira tickets, generating Playwright tests via AI agents, committing to `klikagent-tests`, dispatching CI, and handling PR reviews. Implemented across 4 feature branches, each merged to `main` via PR before the next begins.

## Architecture Decisions (from grilling session)

| Decision | Choice | Rationale |
|---|---|---|
| Issue tracker | GitHub Issues + Labels (not Jira) | MVP simplicity — same GITHUB_TOKEN, pure REST |
| Status triggers | `issues` webhook `labeled` event | `status:in-progress` → Flow 1, `status:ready-for-qa` → Flow 2 |
| Agent-owned transition | Add `status:in-qa`, remove `status:ready-for-qa` via REST | No GraphQL, no Projects setup needed |
| `src/services/issues.ts` | GitHub REST API only | Replaces jira.ts — getIssue, commentOnIssue, addLabel, removeLabel |
| AC location | GitHub Issue body (plain Markdown) | No ADF parsing needed |
| `ticketId` | GitHub issue number e.g. `42` | Branch: `qa/42-short-slug` |
| AI service | OpenAI SDK + Minimax (`ai.ts`) | OpenAI-compatible, user-swappable via env vars |
| `validate_typescript` | Stub (always passes) | Phase 6 polish |
| `diffAnalyzer.ts` | Fetches raw diff only; agent decides `affectedPaths` | No dev repo structure to map against yet |
| Flow 3 | Stub — comment issue with run URL | Full JUnit parsing is Phase 6 |
| `testRepo.ts` | GitHub API, all reads nullable | Stateless, repo-agnostic |
| Review round counting | Body prefix `[KlikAgent]` | PAT not a bot account; GitHub App is Phase 5 |
| CI gate (Flow 2) | Dev PR head commit check-runs | Tied to the actual feature PR |
| `featureDetector.ts` | Internal keyword map | Don't touch `klikagent-tests` config |
| `context/` docs | All agents receive them | Already exist in `klikagent-tests` |
| Orchestrator location | Replace `src/flows/` in-place | Stubs were always placeholders |
| Path aliases | Relative imports | No `paths` in `klikagent-tests` tsconfig |
| `playwright.config.ts` | No changes needed | JUnit reporter already configured ✅ |
| `selective.yml`, `smoke.yml` | No changes needed | Already exist with correct inputs ✅ |

### Label Convention (team agreement required)
```
status:in-progress    → triggers Flow 1 (skeleton generation)
status:ready-for-qa   → triggers Flow 2 (enrichment + CI gate)
status:in-qa          → applied by agent after Flow 2 succeeds
scope:web             → Playwright web tests needed
scope:api             → API tests only (no Playwright)
scope:both            → web + API
scope:none            → skip — no tests needed
feature:auth          → target feature (maps to route)
feature:checkout
feature:e2e           → multi-page sequential crawl
```

---

## Branch Strategy

```
main
 ├── feat/p3-types-utils     → PR 1 (foundation — no dependencies)
 ├── feat/p3-services        → PR 2 (depends on PR 1)
 ├── feat/p3-agents          → PR 3 (depends on PR 2)
 └── feat/p3-orchestrator    → PR 4 (depends on PR 3 + Phase 2 wiring)
```

Each PR is reviewed and merged before the next branch is cut from the updated `main`.

---

## Phase 1: Foundation — `feat/p3-types-utils`

> Types and pure utility functions. No external calls, no AI, fully testable in isolation.

### Task 1.1 — `src/types/index.ts` — Extend with Phase 3 interfaces

**Description:** Add all Phase 3 interfaces to the existing types file. Phase 2 types stay intact. `ReviewContext.comments` upgrades from `string[]` to `ReviewComment[]`.

**Changes:**
- Add `ReviewComment` interface (`id`, `path`, `line`, `body`, `diffHunk`)
- Update `ReviewContext.comments: string[]` → `ReviewComment[]`
- Add `JiraTicket`, `PageSnapshot`, `AriaNode`
- Add `CIResult`, `PR`, `ChangedFile`, `PRComment`
- Add `AgentResult`, `Tool`, `ToolHandler`

**Acceptance criteria:**
- [ ] All Phase 3 interfaces present and exported
- [ ] `ReviewContext.comments` is `ReviewComment[]`
- [ ] `TriggerContext` has no `buildId` field (removed — CI gate uses check-runs)
- [ ] `npm run build` passes with no type errors

**Files:** `src/types/index.ts`
**Scope:** S

---

### Task 1.2 — `src/utils/naming.ts` — Branch slug + PR title formatters

**Description:** Pure functions for generating branch names and PR titles from ticket IDs and summaries.

**Acceptance criteria:**
- [ ] `toBranchSlug(ticketId, summary)` → `qa/KA-42-short-summary` (lowercase, hyphens, max 50 chars)
- [ ] `toPRTitle(ticketId, summary)` → `[KlikAgent] KA-42: Short summary`
- [ ] `toReworkBranch(parentId, n)` → `qa/KA-42-rework-1`
- [ ] No external dependencies

**Files:** `src/utils/naming.ts`
**Scope:** XS

---

### Task 1.3 — `src/utils/bdd.ts` — AC parser + guard

**Description:** Extract and validate Acceptance Criteria from Jira description text. Handles both plain text and ADF (Atlassian Document Format) — recursively walks ADF `content` nodes to extract text, then checks for `Given/When/Then` keywords.

**Acceptance criteria:**
- [ ] `extractText(description: unknown): string` handles plain string and ADF object
- [ ] `hasAcceptanceCriteria(text: string): boolean` returns true if `Given`, `When`, `Then` all present (case-insensitive)
- [ ] `parseAC(text: string): string` returns the AC block (everything after first `Given`)
- [ ] Returns `false` for empty string, null, undefined, ADF with no text nodes

**Files:** `src/utils/bdd.ts`
**Scope:** S

---

### Task 1.4 — `src/utils/featureDetector.ts` — Keyword inference

**Description:** Infers feature name from AC text using an internal keyword map. Route-map keys are the feature names. Fallback is `'general'`.

**Acceptance criteria:**
- [ ] `detectFeature(acText: string, labels: string[]): string`
- [ ] `feature:*` label takes priority over keyword inference
- [ ] Keyword map covers: `auth`, `checkout`, `search`, `profile`, `dashboard`
- [ ] Returns `'general'` when no match found
- [ ] Case-insensitive matching

**Files:** `src/utils/featureDetector.ts`
**Scope:** XS

---

### Task 1.5 — `src/utils/routeResolver.ts` — Feature label → URL(s)

**Description:** Resolves a feature name to one or more URLs to crawl. For `feature:e2e`, parses AC to extract sequential page flow. Uses the `klikagent-tests` route map shape.

**Acceptance criteria:**
- [ ] `resolveUrls(feature: string, acText: string, routeMap: Record<string, string>): string[]`
- [ ] Single feature → single URL from route map
- [ ] `feature:e2e` → multiple URLs extracted from AC page mentions
- [ ] Unknown feature → empty array (caller handles)

**Files:** `src/utils/routeResolver.ts`
**Scope:** S

---

### Task 1.6 — `src/utils/diffAnalyzer.ts` — Raw PR diff fetcher

**Description:** Fetches the raw unified diff text from a GitHub PR. No analysis — returns the raw string. Agent determines `affectedPaths` from this.

**Acceptance criteria:**
- [ ] `fetchPRDiff(prNumber: number, owner: string, repo: string, token: string): Promise<string>`
- [ ] Uses `Accept: application/vnd.github.diff` header
- [ ] Returns empty string on 404 or error (not a throw)

**Files:** `src/utils/diffAnalyzer.ts`
**Scope:** XS

---

### Checkpoint 1 — Branch `feat/p3-types-utils`

- [ ] `npm run build` — zero TypeScript errors
- [ ] `npm test` — all existing Phase 2 tests pass
- [ ] PR opened → reviewed → merged to `main`

---

## Phase 2: Services — `feat/p3-services`

> External API wrappers. Each is a thin, typed wrapper — no business logic.

### Task 2.1 — `src/services/issues.ts` — GitHub Issues service

**Description:** Wraps GitHub Issues REST API. Replaces `jira.ts` entirely. Uses the existing `GITHUB_TOKEN` — no new credentials. AC is plain Markdown from issue body.

**Acceptance criteria:**
- [ ] `getIssue(issueNumber): Promise<GitHubIssue>` — maps to shared `Issue` interface (number, title, body, labels[])
- [ ] `commentOnIssue(issueNumber, body): Promise<void>` — posts Markdown comment
- [ ] `addLabel(issueNumber, label): Promise<void>`
- [ ] `removeLabel(issueNumber, label): Promise<void>`
- [ ] `transitionToInQA(issueNumber): Promise<void>` — adds `status:in-qa`, removes `status:ready-for-qa`
- [ ] All methods throw descriptive errors on non-2xx responses

**Files:** `src/services/issues.ts`
**Scope:** S

---

### Task 2.2 — `src/services/github.ts` — GitHub REST API wrapper

**Description:** Typed wrapper for all GitHub API calls needed by Phase 3. No business logic — pure API surface.

**Acceptance criteria:**
- [ ] `getCIStatus(owner, repo, prNumber): Promise<CIResult>` — finds dev PR by ticket ID prefix, checks head commit check-runs
- [ ] `findPRByTicketId(ticketId, repo): Promise<PR | null>`
- [ ] `findBranchesByPattern(repo, pattern): Promise<string[]>`
- [ ] `getPRDiff(prNumber, repo): Promise<string>` — raw diff text
- [ ] `getPRComments(prNumber, repo): Promise<PRComment[]>`
- [ ] `getReviewComments(prNumber, reviewId, repo): Promise<ReviewComment[]>`
- [ ] `replyToReviewComment(prNumber, repo, commentId, body): Promise<void>`
- [ ] `requestReview(prNumber, repo, reviewer): Promise<void>`
- [ ] `getDefaultBranchSha(repo): Promise<string>`
- [ ] `createBranch(repo, branchName, baseSha): Promise<void>`
- [ ] `commitFile(repo, branch, path, content, message): Promise<void>` — creates or updates via contents API
- [ ] `getFileOnBranch(repo, branch, path): Promise<string | null>` — returns null on 404
- [ ] `openPR(repo, branch, title, body, draft?): Promise<string>` — returns PR URL
- [ ] `triggerWorkflow(repo, workflow, ref, inputs): Promise<void>`

**Files:** `src/services/github.ts`
**Scope:** L

---

### Task 2.3 — `src/services/crawler.ts` — Playwright page snapshot

**Description:** Headless Playwright script that authenticates, navigates, runs the standard reveal pass, and returns a `PageSnapshot`. Called by the orchestrator before enrichment agents run — not by agents directly.

**Acceptance criteria:**
- [ ] `captureSnapshot(url: string): Promise<PageSnapshot>`
- [ ] `captureSnapshots(urls: string[]): Promise<PageSnapshot[]>` — single session, authenticated once
- [ ] Auth uses `QA_BASE_URL/login` with `QA_USER_EMAIL` + `QA_USER_PASSWORD`
- [ ] Standard reveal pass runs before `page.accessibility.snapshot()`
- [ ] `testIds[]` supplemented from `data-testid` elements not in ARIA tree
- [ ] Throws with descriptive message on navigation failure (caller comments Jira + halts)
- [ ] Requires `playwright` added to dependencies

**Files:** `src/services/crawler.ts`
**Scope:** M

---

### Task 2.4 — `src/services/testRepo.ts` — `klikagent-tests` reader via GitHub API

**Description:** Reads files from `klikagent-tests` repo via GitHub contents API. All reads return `null` on 404 — agents handle missing files gracefully.

**Acceptance criteria:**
- [ ] `getRouteMap(): Promise<Record<string, string>>` — parses `config/routes.ts`
- [ ] `getTsConfig(): Promise<string>`
- [ ] `getPlaywrightConfig(): Promise<string>`
- [ ] `getContextDocs(): Promise<Record<string, string>>` — all `.md` files from `context/`
- [ ] `getExistingPOMNames(feature): Promise<string[]>`
- [ ] `getExistingTests(feature): Promise<Record<string, string>>` — filename → content
- [ ] `getSkeletonSpec(branch, ticketId, feature): Promise<string | null>`
- [ ] `getExistingPOM(feature): Promise<string | null>`
- [ ] `getFixtures(): Promise<string>`
- [ ] `getHelpers(): Promise<Record<string, string>>`
- [ ] `getParentSpec(branch, parentTicketId, feature): Promise<string | null>`
- [ ] `getCurrentSpec(branch, ticketId, feature): Promise<string | null>`
- [ ] `getCurrentPOM(branch, feature): Promise<string | null>`
- [ ] `commitFile(branch, path, content, message): Promise<void>` — delegates to `github.ts`

**Files:** `src/services/testRepo.ts`
**Scope:** M

---

### Task 2.5 — `src/services/ai.ts` — Generic agent tool loop

**Description:** Provider-agnostic AI service using OpenAI SDK with configurable `baseURL`. Implements the tool loop: call model → handle `tool_calls` → call handlers → repeat until `done()`. Minimax-compatible.

**Acceptance criteria:**
- [ ] `runAgent(systemPrompt, userMessage, tools, toolHandlers, options?): Promise<Record<string, unknown>>`
- [ ] Uses `openai` npm package with `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` env vars
- [ ] Tool loop handles `finish_reason === 'tool_calls'` correctly
- [ ] `done` tool name exits the loop and returns its parsed args
- [ ] Throws after `maxIterations` (default 20) with descriptive message
- [ ] `model`, `maxTokens`, `maxIterations` configurable per call via `options`
- [ ] Requires `openai` added to dependencies

**Files:** `src/services/ai.ts`
**Scope:** M

---

### Checkpoint 2 — Branch `feat/p3-services`

- [ ] `npm run build` — zero TypeScript errors
- [ ] `npm test` — all existing tests pass
- [ ] Each service is independently importable without crashing on missing env vars (lazy init)
- [ ] PR opened → reviewed → merged to `main`

---

## Phase 3: Agents — `feat/p3-agents`

> Agent tools and the four AI agents. Depends on all services.

### Task 3.1 — `src/agents/tools/repoTools.ts` — Context tool definitions

**Description:** Tool definitions and handlers that give agents access to `klikagent-tests` context. Wraps `testRepo.ts` methods as agent-callable tools.

**Tools defined:**
- `get_route_map`, `get_existing_pom_names`, `get_existing_tests`
- `get_skeleton_spec`, `get_existing_pom`, `get_fixtures`, `get_helpers`
- `get_parent_spec`, `get_current_spec`, `get_current_pom`
- `get_tsconfig`, `get_playwright_config`, `get_context_docs`

**Acceptance criteria:**
- [ ] Each tool has correct JSON schema for its parameters
- [ ] Each handler calls the corresponding `testRepo.ts` method
- [ ] Returns stringified content (agents receive text, not objects)

**Files:** `src/agents/tools/repoTools.ts`
**Scope:** M

---

### Task 3.2 — `src/agents/tools/githubTools.ts` — PR read tools (Review Agent)

**Description:** Tool definitions for the Review Agent to read PR state.

**Tools defined:**
- `get_full_review_comments` — fetches inline review comments via GitHub API

**Acceptance criteria:**
- [ ] Tool schema matches `ReviewComment[]` shape
- [ ] Handler calls `github.getReviewComments()`

**Files:** `src/agents/tools/githubTools.ts`
**Scope:** XS

---

### Task 3.3 — `src/agents/tools/outputTools.ts` — `done()` tool definitions

**Description:** One `done()` tool per agent type with the correct output schema.

**Tools defined:**
- `done_skeleton` — `{ skeletonSpec: string }`
- `done_enrichment` — `{ enrichedSpec: string, pomContent: string, affectedPaths: string }`
- `done_rework` — `{ patchedSpec: string, pomContent: string }`
- `done_review` — `{ fixedSpec: string, pomContent: string, commentReplies: {commentId: number, body: string}[] }`
- `done_validate` — stub — `{ valid: true }` always (MVP)

**Acceptance criteria:**
- [ ] All `done()` variants have strict JSON schemas
- [ ] `validate_typescript` tool always returns `{ valid: true, errors: [] }`

**Files:** `src/agents/tools/outputTools.ts`
**Scope:** S

---

### Task 3.4 — `src/agents/tools/index.ts` — Tool registry

**Description:** Exports tool sets per agent type — clean composition of repo + github + output tools.

**Acceptance criteria:**
- [ ] `skeletonTools`, `enrichmentTools`, `reworkTools`, `reviewTools` exported
- [ ] Each set is the union of the correct tool subsets

**Files:** `src/agents/tools/index.ts`
**Scope:** XS

---

### Task 3.5 — `src/agents/skeletonAgent.ts` — Flow 1 test skeleton generator

**Description:** Calls `runAgent()` with the Skeleton Agent system prompt. Loads full `klikagent-tests` context + `context/` docs. Normal and rework modes distinguished by `isRework` flag. Generated code uses relative imports, no `@` aliases.

**Acceptance criteria:**
- [ ] `runSkeletonAgent(ticket, feature, isRework): Promise<string>`
- [ ] System prompt matches spec Section 8.2
- [ ] Rework mode adds parent spec tool + adjusted prompt
- [ ] Agent receives `context/` docs in user message
- [ ] Returns skeleton spec string from `done()` call

**Files:** `src/agents/skeletonAgent.ts`
**Scope:** M

---

### Task 3.6 — `src/agents/enrichmentAgent.ts` — Flow 2 spec enrichment

**Description:** Receives skeleton spec + `PageSnapshot[]` (pre-captured by crawler). Generates runnable spec + POM. `affectedPaths` comes from the agent's `done()` output — informed by raw PR diff passed in user message.

**Acceptance criteria:**
- [ ] `runEnrichmentAgent(ticket, feature, branch, snapshots, prDiff): Promise<{enrichedSpec, pomContent, affectedPaths}>`
- [ ] System prompt matches spec Section 8.3
- [ ] Page snapshots serialized to user message (not a tool call)
- [ ] Raw PR diff included in user message
- [ ] Agent receives `context/` docs
- [ ] Returns all three fields from `done_enrichment()`

**Files:** `src/agents/enrichmentAgent.ts`
**Scope:** M

---

### Task 3.7 — `src/agents/reworkAgent.ts` — Rework surgical patch

**Description:** Surgical spec patching agent. Receives parent spec + rework description + page snapshots. Applies spec patch rules from Section 6.6.

**Acceptance criteria:**
- [ ] `runReworkAgent(subtask, parentTicket, feature, branch, snapshots): Promise<{patchedSpec, pomContent}>`
- [ ] System prompt matches spec Section 8.4
- [ ] Patch rules enforced via prompt (never delete, never rewrite wholesale)
- [ ] Agent receives `context/` docs
- [ ] Returns patched spec + POM from `done_rework()`

**Files:** `src/agents/reworkAgent.ts`
**Scope:** M

---

### Task 3.8 — `src/agents/reviewAgent.ts` — PR CHANGES_REQUESTED handler

**Description:** Replaces the Phase 2 stub. Processes all review comments as a batch. Round limit checked before agent runs. Produces fixes + reply texts.

**Acceptance criteria:**
- [ ] `runReviewAgent(ctx, feature): Promise<{fixedSpec, pomContent, commentReplies}>`
- [ ] System prompt matches spec Section 9.4
- [ ] Agent receives all inline comments in user message
- [ ] Agent receives `context/` docs
- [ ] Returns `commentReplies[]` matching inline comment IDs
- [ ] `validate_typescript` tool available (stub, always passes)

**Files:** `src/agents/reviewAgent.ts`
**Scope:** M

---

### Checkpoint 3 — Branch `feat/p3-agents`

- [ ] `npm run build` — zero TypeScript errors
- [ ] `npm test` — all existing tests pass
- [ ] All agent files export their typed functions
- [ ] PR opened → reviewed → merged to `main`

---

## Phase 4: Orchestrator + Wiring — `feat/p3-orchestrator`

> The brains. Replaces Phase 2 stubs. Wires everything together.

### Task 4.1 — `src/orchestrator/flow1-ticket-to-active.ts`

**Description:** Replaces `src/flows/flow1.ts`. Implements scope guard → AC guard → Skeleton Agent → commit → open draft PR → comment Jira. Normal and rework branches.

**Acceptance criteria:**
- [ ] `scope:none` or `scope:api` only → comment Jira with correct template + return
- [ ] AC missing → comment Jira with correct template + return
- [ ] Normal: Skeleton Agent → commit to `qa/{ticketId}-{slug}` → open draft PR → comment Jira
- [ ] Rework: reads parent ticket + subtask → Skeleton Agent rework mode → resolve branch → commit → comment subtask Jira
- [ ] All Jira comments match templates in spec Section 5.1

**Files:** `src/orchestrator/flow1-ticket-to-active.ts`
**Scope:** M

---

### Task 4.2 — `src/orchestrator/flow2-ticket-to-ready.ts`

**Description:** Replaces `src/flows/flow2.ts`. CI gate → Enrichment Agent → commit → dispatch selective + smoke in parallel → comment Jira. Rework path uses Rework Agent.

**Acceptance criteria:**
- [ ] CI gate: find dev PR → check head commit check-runs → red = comment Jira + halt
- [ ] CI green: run crawler → run Enrichment Agent (or Rework Agent if `isRework`)
- [ ] Commit enriched spec + POM to branch
- [ ] Transition ticket → `In QA` (dynamic lookup)
- [ ] Dispatch `selective.yml` + `smoke.yml` in parallel
- [ ] Comment Jira with both workflow URLs + enriched spec
- [ ] Rework path: resolve branch, commit patched spec, open PR if new branch

**Files:** `src/orchestrator/flow2-ticket-to-ready.ts`
**Scope:** L

---

### Task 4.3 — `src/orchestrator/flow3-tests-complete.ts`

**Description:** Replaces `src/flows/flow3.ts`. MVP: comment Jira with run URL. Rework: also signal parent ticket if runType indicates all passed.

**Acceptance criteria:**
- [ ] `runType: 'new-tests' | 'affected'` → selective comment template
- [ ] `runType: 'smoke'` → smoke comment template
- [ ] Rework (`isRework: true`) → also post signal on parent ticket
- [ ] All comment templates match spec Section 5.3
- [ ] No JUnit parsing for MVP — run URL only

**Files:** `src/orchestrator/flow3-tests-complete.ts`
**Scope:** S

---

### Task 4.4 — `src/orchestrator/index.ts` — Main router

**Description:** Routes `TriggerContext` and `ReviewContext` to the correct orchestrator. Wraps all calls in try/catch with Jira error comments. Replaces the role of `src/flows/` routing.

**Acceptance criteria:**
- [ ] `handleTrigger(ctx: TriggerContext): Promise<void>` — routes flow 1/2/3
- [ ] `handleReview(ctx: ReviewContext): Promise<void>` — runs Review Agent flow incl. round limit check
- [ ] Round limit: counts `[KlikAgent]` prefixed bot comments on PR → if ≥ 3, post limit message + halt
- [ ] All errors caught → `log()` + `jira.commentOnTicket()` with error template + return
- [ ] `maxIterations` exceeded error is caught and commented on Jira

**Files:** `src/orchestrator/index.ts`
**Scope:** M

---

### Task 4.5 — Wire Phase 2 → orchestrator + update Phase 2 GitHub parser

**Description:** Wiring changes to existing Phase 2 files + delete Jira webhook infrastructure:

1. `src/webhook/server.ts` — remove `/webhook/jira` route entirely; add `issues` event routing
2. `src/webhook/github/parser.ts` — add `issues` event handler: `action: labeled`, map label name to flow; also update `handlePRReview()` to fetch inline review comments → `ReviewComment[]`
3. `src/webhook/github/router.ts` — import `handleReview` + `handleTrigger` from orchestrator
4. Delete `src/webhook/jira/` directory (parser.ts, router.ts, parser.test.ts)
5. Delete `src/flows/flow1.ts`, `flow2.ts`, `flow3.ts`
6. Delete old `src/agents/reviewAgent.ts` stub

**Label → flow mapping:**
```typescript
'status:in-progress'  → flow 1
'status:ready-for-qa' → flow 2
```

**Acceptance criteria:**
- [ ] `src/webhook/jira/` directory removed
- [ ] `src/flows/` directory removed
- [ ] `/webhook/jira` Express route removed from server.ts
- [ ] `issues` `labeled` event builds correct `TriggerContext` (flow 1 or 2)
- [ ] `handlePRReview()` fetches inline comments + maps to `ReviewComment[]`
- [ ] `npm run build` — zero errors
- [ ] `npm test` — all existing passing tests still pass

**Files:** `src/webhook/server.ts`, `src/webhook/github/parser.ts`, `src/webhook/github/router.ts`
**Scope:** M

---

### Task 4.6 — `.env.example` — Document all Phase 3 env vars

**Description:** Extend `.env.example` with all new environment variables Phase 3 introduces.

**New vars to add (remove all JIRA_* vars):**
```
# AI Provider (OpenAI-compatible — Minimax, OpenAI, Together, etc.)
AI_API_KEY=your_api_key_here
AI_BASE_URL=https://api.minimax.io/v1
AI_MODEL=MiniMax-M2.7

# GitHub — main dev repo (for CI gate check-runs)
GITHUB_MAIN_REPO=your-main-app-repo

# QA Environment (for Playwright crawler)
QA_BASE_URL=https://qa.yourapp.com
QA_USER_EMAIL=qa_seed_user@example.com
QA_USER_PASSWORD=your_qa_password_here
```

**Remove from .env.example:**
- `JIRA_WEBHOOK_SECRET` — replaced by GitHub Issues labels
- (JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN were never in .env.example — not needed)

**Acceptance criteria:**
- [ ] All Phase 3 vars documented with comments
- [ ] `AI_*` prefix used (not `CLAUDE_*`)
- [ ] `JIRA_WEBHOOK_SECRET` removed
- [ ] Label convention documented in a comment block

**Files:** `.env.example`
**Scope:** XS

---

### Checkpoint 4 — Branch `feat/p3-orchestrator`

- [ ] `npm run build` — zero TypeScript errors
- [ ] `npm test` — all tests pass
- [ ] `src/flows/` directory does not exist
- [ ] End-to-end trace: mock Jira webhook → routes to `orchestrator/index` → calls correct flow
- [ ] PR opened → reviewed → merged to `main`

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Minimax tool_calls format differs from spec examples | High | Verified OpenAI-compatible — format confirmed in grilling |
| `klikagent-tests` GitHub API rate limits during agent context loading | Med | All reads cached within a single agent run; 5,000 req/hr PAT limit is sufficient |
| Playwright crawler auth flow unknown without real app | Med | Crawler throws on failure; orchestrator comments Jira + halts; skeleton stays on branch |
| ADF description parsing misses AC | Med | `extractText()` walks all content node types; fallback to raw JSON string if walk fails |
| Review round counting miscounts | Low | Counts comment threads where body starts with `[KlikAgent] Fixed:` or `[KlikAgent] Noted:` |

## Open Questions (resolved)

All questions resolved in grilling session. No blockers to implementation.

---

*Plan version: 1.0 — post-grilling-session*
*Ready for implementation in branch order: p3-types-utils → p3-services → p3-agents → p3-orchestrator*
