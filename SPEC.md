# KlikAgent — Multi-Repo Tool Spec

## 1. Objective

Turn KlikAgent from a single-team QA spec generator into a shared internal tool that any QA team can onboard onto. Teams provision a convention-based test repo and immediately receive AI-generated Playwright specs and review feedback via the existing REST interface — without touching the KlikAgent codebase.

**Target users:** QA Engineers across internal teams.
**Deployment model:** One shared KlikAgent instance serves all teams.

---

## 2. Core Features

### 2.1 Multi-Repo Spec Generation (existing, refactored)

- `POST /tasks` accepts a normalized `QATask` payload with `outputRepo` identifying the target test repo.
- The QA agent reads context (routes, keywords, domain docs, fixtures, POMs) from `task.outputRepo` — not from a global env var.
- The agent writes specs and POMs back to the same `task.outputRepo`.
- Read and write always target the same repo. The `GITHUB_TEST_REPO` env var is removed.

### 2.2 Multi-Repo Review Agent (existing, refactored)

- `POST /reviews` accepts a `ReviewContext` payload extended with `outputRepo`.
- The Review Agent reads spec context from `outputRepo` (same pattern as QA agent).
- Review comments are posted back to the PR in the same `outputRepo`.

### 2.3 Repo Provisioner (new)

- `POST /repos/provision` scaffolds a brand-new convention-compliant test repo for a team.
- KlikAgent creates the GitHub repo and seeds all required directories and files via the GitHub API.
- No manual setup required for a team to start receiving specs.

### 2.4 Observability Dashboard (existing, unchanged)

- Real-time run events visible at the dashboard endpoint.
- Spans all repos — runs are tagged by `taskId` and `outputRepo`.

---

## 3. Test Repo Convention

All test repos managed by KlikAgent follow this exact directory layout. KlikAgent assumes this structure without validation — teams must provision via the provisioner or manually mirror it.

```
config/
  routes.ts           # feature-name → base URL path map
  keywords.json       # feature-name → keyword list for agent feature detection
context/
  domain.md           # app domain knowledge (seeded at provision time)
  personas.md         # user personas (seeded at provision time)
  test-patterns.md    # testing patterns and conventions
fixtures/
  index.ts            # Playwright fixture definitions and POM registrations
pages/
  {feature}/
    {ClassName}Page.ts  # one POM file per feature
tests/
  web/
    {feature}/
      {ticketId}.spec.ts  # generated specs
utils/
  helpers.ts          # shared test helpers
tsconfig.json
playwright.config.ts
```

**Branch convention:** `qa/{ticketId}-{slug}` (enforced by `toBranchSlug`, max 40 chars slug)
**Commit convention:** `feat(spec): add #{taskId} spec [klikagent]`
**KlikAgent never pushes to the default branch.** All output lands on a `qa/` branch via PR.

---

## 4. API Endpoints

### Existing (unchanged contract, refactored internals)

```
POST /tasks
Body: QATask
Response: 202 { received: true, taskId }
```

```
POST /reviews
Body: ReviewContext  ← add outputRepo field
Response: 202 { received: true, prNumber }
```

```
POST /tasks/:id/results
Body: TaskResult
Response: 200 { received: true }
```

```
GET /health
Response: 200 { status: 'ok' }
```

### New

```
POST /repos/provision
Body: ProvisionRequest
Response: 201 { repoUrl, cloneUrl, defaultBranch }
```

---

## 5. Type Definitions

### Updated: `ReviewContext`

```typescript
export interface ReviewContext {
  prNumber: number;
  repo: string;         // kept for backwards compat (same as outputRepo)
  outputRepo: string;   // explicit: the repo to read/write
  branch: string;
  ticketId: string;
  reviewId: number;
  reviewerLogin: string;
  comments: ReviewComment[];
}
```

### New: `ProvisionRequest`

```typescript
export interface ProvisionRequest {
  repoName: string;           // e.g. "myteam-tests"
  owner: string;              // GitHub org or user
  qaEnvUrl: string;           // base URL of the QA environment
  features: string[];         // e.g. ["auth", "billing", "dashboard"]
  domainContext: string;      // paragraph describing the app — seeded into context/domain.md
}

export interface ProvisionResult {
  repoUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}
```

---

## 6. Architecture Changes

### 6.1 Fix the read/write repo split

**Current (broken for multi-repo):**
```
testRepo.ts → testRepoName() → process.env.GITHUB_TEST_REPO  (global singleton)
```

**Target:**
```
repoTools.ts → createRepoToolHandlers(repoName) → testRepo.*(repoName)
```

All `testRepo.*` functions gain a `repoName: string` parameter. The global `testRepoName()` helper is removed.

### 6.2 `repoTools.ts` — factory pattern

Replace the static exported `repoToolHandlers` object with a factory:

```typescript
export function createRepoToolHandlers(repoName: string): ToolHandlers { ... }
```

Called at agent startup with `task.outputRepo`, not at module load time.

### 6.3 `tools/index.ts` — factory functions

Replace static `qaHandlers` / `reviewHandlers` exports with factories:

```typescript
export function createQaHandlers(repoName: string): ToolHandlers { ... }
export function createReviewHandlers(repoName: string): ToolHandlers { ... }
```

### 6.4 `selfCorrection.ts` — pass repoName through

```typescript
export async function runWithSelfCorrection(
  task: QATask,
  branch: string,
): Promise<SelfCorrectionResult>
```

Internally builds handlers via `createQaHandlers(task.outputRepo)`. No signature change.

### 6.5 `reviewAgent.ts` — pass repoName through

Builds handlers via `createReviewHandlers(ctx.outputRepo)`.

### 6.6 New: `src/services/repoProvisioner.ts`

Handles `POST /repos/provision`:
1. Create GitHub repo via API (`POST /user/repos` or `POST /orgs/{org}/repos`)
2. Get default branch SHA
3. Commit all convention files in one batch (one commit per file via GitHub Contents API)
4. Return repo URL

Seed file content is generated from the `ProvisionRequest` inputs — `domainContext` is written into `context/domain.md`, `features` seed `config/routes.ts` and `config/keywords.json`.

### 6.7 Remove `GITHUB_TEST_REPO` env var

All references replaced by `task.outputRepo` / `ctx.outputRepo`. Update `.env.example` and `AGENTS.md`.

---

## 7. Project Structure After Changes

```
src/
  agents/
    tools/
      index.ts          ← factory functions instead of static exports
      repoTools.ts      ← createRepoToolHandlers(repoName) factory
      githubTools.ts    ← unchanged
      outputTools.ts    ← unchanged
    qaAgent.ts          ← unchanged
    reviewAgent.ts      ← uses createReviewHandlers(ctx.outputRepo)
  orchestrator/
    index.ts            ← unchanged
    generateQaSpecFlow.ts ← unchanged (passes task through)
  services/
    testRepo.ts         ← all functions accept repoName param
    repoProvisioner.ts  ← NEW
    github.ts           ← remove testRepoName(), keep ownerName()
    ai.ts               ← unchanged
    selfCorrection.ts   ← uses createQaHandlers(task.outputRepo)
    browserTools.ts     ← unchanged
    personas.ts         ← unchanged
  types/
    index.ts            ← add ProvisionRequest, ProvisionResult; update ReviewContext
  webhook/
    server.ts           ← add POST /repos/provision route
  dashboard/            ← unchanged
  utils/                ← unchanged
```

---

## 8. Code Style

- TypeScript strict mode, no `any`.
- Functions over classes. No singletons (the `testRepoName()` global is the anti-pattern being removed).
- Factory functions return plain objects (`ToolHandlers`), not class instances.
- All GitHub API calls go through `ghRequest()` in `github.ts` — no direct `fetch` to GitHub API elsewhere.
- Async/await throughout, no `.then()` chains except in fire-and-forget handlers in `server.ts`.
- Errors surface via thrown `Error` — never swallowed silently. Warn-log at boundaries, rethrow or return structured results.

---

## 9. Testing Strategy

### Unit tests (Jest)

- `testRepo.ts` — all functions accept and use the `repoName` param; mock `ghRequest`.
- `repoTools.ts` — `createRepoToolHandlers(repoName)` returns handlers that call testRepo with the correct repo name.
- `repoProvisioner.ts` — mock GitHub API; verify each seed file is committed with the correct path and content derived from `ProvisionRequest`.
- `tools/index.ts` — `createQaHandlers` and `createReviewHandlers` wire repoName into repo tool handlers.

### Integration tests (existing, extended)

- `generateQaSpecFlow.test.ts` — extend to assert that all testRepo reads use `task.outputRepo`, not a hardcoded env var.
- `server.ts` — add route test for `POST /repos/provision` (valid body → 201, missing fields → 400).

### What we do NOT test

- Live GitHub API calls — all mocked at `ghRequest` boundary.
- The AI agent's output quality — that's prompt engineering, not unit logic.

---

## 10. Boundaries

| Rule | Rationale |
|---|---|
| Never push to the default branch of a test repo | All output goes to `qa/` branches; merging is a human decision |
| Never delete or overwrite existing spec files | KlikAgent creates, never mutates existing work |
| Never read from a repo other than `task.outputRepo` | Eliminates the read/write split bug |
| Never skip PR creation | The draft PR is the handoff mechanism to QA engineers |
| One shared GitHub token | Internal tool — per-team token isolation is out of scope |
| No HMAC validation on incoming requests | Internal network — callers are trusted trigger services |
| Provisioner creates repos; it does not delete or rename them | Destructive repo operations require human action |
