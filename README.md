# KlikAgent — QA Orchestrator

AI-powered QA automation engine. Receives a `QATask` payload, sends an Explorer agent to browse the target app, hands a structured report to a Writer agent that generates a Playwright spec + Page Object Model, runs a two-phase self-correction loop, and opens a draft PR.

Part of a three-repo system:

| Repo | Role |
|---|---|
| `klikagent` | Core orchestrator — this repo |
| `klikagent-github-trigger` | GitHub webhook adapter (HMAC validation, event parsing) |
| `klikagent-demo-tests` | Generated test output, CI runner, GitHub Pages dashboard |

For the full sequence diagram, interface contracts, and design decisions, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## How a Run Flows

```
GitHub Issue (labeled "klikagent")
         │
         ▼
klikagent-github-trigger          ← HMAC validation, payload parsing
         │
         │  POST /tasks  (QATask)
         ▼
    klikagent
    │
    │  1. ensureRepo(outputRepo)              local clone (auto-sync every 5 min)
    │  2. Create branch  qa/{taskId}-{slug}
    │  3. Explorer Agent  +  base context prefetch        (in parallel)
    │       browser-driven exploration → ExplorationReport
    │  4. Writer Agent
    │       ExplorationReport + WriterContext → files[]   (spec, pom, fixture, extra)
    │  5. Self-Correction
    │       Phase 1 (fast)  convention rules + AST → parallel per-file fix agents
    │       Phase 2 (slow)  tsc --noEmit + eslint in a temp clone → fix agent
    │  6. Commit each file in files[] to branch
    │  7. Open Draft PR in output repo
    │  8. POST TaskResult → callbackUrl
    │
         │
         │  POST /callback/tasks/:id/results
         ▼
klikagent-github-trigger          ← comments on issue, transitions label
         │
         ▼
playwright.yml CI runs in klikagent-demo-tests
         │
         │  POST /tasks/:id/results  (failures, if any)
         ▼
    klikagent                     ← runWithCiFailureFix re-navigates and patches
```

---

## Endpoints

All endpoints are on `src/webhook/server.ts`. There is **no** `/webhook/github` route here — HMAC validation and GitHub parsing live in `klikagent-github-trigger`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/tasks` | Trigger QA spec generation. Accepts `QATask`. Returns 202 immediately; processes async. 409 if `taskId` is already running. |
| `POST` | `/reviews` | Trigger Review Agent on a CHANGES_REQUESTED PR review. Accepts `ReviewContext`. |
| `POST` | `/tasks/:id/results` | CI reports Playwright test results back. |
| `POST` | `/repos/provision` | Scaffold a new convention-compliant test repo (creates GitHub repo, seeds context). |
| `GET` | `/health` | Health check. |
| `GET` | `/dashboard` | Live dashboard UI with SSE event stream. |

---

## Data Contracts

### QATask — inbound from trigger services

```typescript
interface QATask {
  taskId: string;        // GitHub issue number, e.g. "42"
  title: string;
  description: string;   // Acceptance criteria from issue body
  qaEnvUrl: string;      // e.g. "https://app.testingwithekki.com"
  outputRepo: string;    // e.g. "klikagent-demo-tests"
  feature?: string;      // e.g. "auth" — routes spec to tests/web/auth/
  callbackUrl?: string;  // KlikAgent POSTs TaskResult here on completion
  metadata?: Record<string, unknown>;
}
```

### TaskResult — outbound to callbackUrl

```typescript
interface TaskResult {
  taskId: string;
  passed: boolean;       // false when self-correction warned
  summary: string;
  reportUrl?: string;    // link to draft PR
  metadata?: {
    tokenUsage: { promptTokens, completionTokens, totalTokens, costUSD };
    warned: boolean;
    warningMessage?: string;
  };
}
```

### ReviewContext — inbound from trigger on CHANGES_REQUESTED

```typescript
interface ReviewContext {
  prNumber: number;
  repo: string;                 // backwards-compat
  outputRepo: string;           // canonical
  branch: string;
  ticketId: string;
  reviewId: number;
  reviewerLogin: string;
  comments: ReviewComment[];    // pre-fetched at trigger
  specPath: string;             // e.g. "tests/web/auth/qa-auth-flow.spec.ts"
}
```

### ExplorationReport — internal handoff Explorer → Writer

```typescript
interface ExplorationReport {
  feature: string;
  visitedRoutes: string[];
  authPersona: string;
  locators: Record<string, Record<string, string>>;  // route → name → generatedCode
  flows: ObservedFlow[];                              // { name, steps, observed }
  missingLocators: MissingLocator[];                  // { route, name, reason }
  notes: string[];
}
```

### FileEntry — agent output schema

All agents that emit code return `files: FileEntry[]`:

```typescript
interface FileEntry {
  path: string;
  content: string;
  role: 'spec' | 'pom' | 'fixture' | 'extra';
}
```

---

## Two-Agent Pipeline

### Explorer Agent (`src/agents/explorerAgent.ts`)

Browses the target app via `playwright-cli` (persistent session), collects element references and observed flows, produces an `ExplorationReport`. Never writes code.

**Tools available:**
- `browser_navigate(url, persona?)` — navigates; auto-loads `.playwright-auth/{persona}.json` and switches storageState mid-session if persona changes
- `browser_click(ref)` / `browser_fill(ref, value)` — interact via aria refs (`e1`, `e2`, …); each action returns `generatedCode`
- `browser_generate_locator(ref)` — resolve a ref to a Playwright locator without interacting
- `browser_command(cmd, args)` — escape hatch for `state-save`, `state-load`, etc.
- `browser_eval(expression, ref?)` — read attributes not in the snapshot
- `browser_close()` — tear down the session
- Repo read tools: `get_personas`, `get_fixtures`, `get_context_docs`, `list_available_poms`, `get_existing_pom`, `get_existing_tests`, `get_route_map`, `get_helpers`, `get_tsconfig`, `get_playwright_config`
- `exploration_done(ExplorationReport)`

While the Explorer is running, the orchestrator prefetches the feature-independent parts of the Writer's context (fixtures, personas, context docs, POMs list, golden examples) in parallel.

### Writer Agent (`src/agents/writerAgent.ts`)

Reads the `ExplorationReport` and a pre-fetched `WriterContext`, generates spec + POM, validates each file. Never touches the browser.

**Pre-fetched context (`src/services/writerContext.ts`):**
- `fixtures/index.ts`, `config/personas.ts`, `context/*.md`
- All POM paths in `pages/`
- Existing tests in `tests/web/{feature}/`, existing POM at `pages/{feature}/`
- 7 golden pattern snippets (auth tests, persona-fixture feature tests, dynamic persona data, POM-method access, access-control tests, POM template)

**Tools available:**
- `validate_typescript({ code, fileType })` — in-memory AST parse per file
- Discovery tools: `search_codebase(query, filePattern?, path?)`, `get_file(path)`, `list_directory(path)`
- `done({ feature, files, affectedPaths })`

---

## Self-Correction Loop (`src/services/selfCorrection.ts`)

Runs after the Writer agent emits files. `MAX_SELF_CORRECTION_ATTEMPTS` controls the budget per phase (default: 10).

### Phase 1 — Fast (in-process)

Convention rules (regex + AST) plus an in-memory `ts.createSourceFile` parse on each file. Violations are partitioned by target file and fixed by parallel agents (concurrency = 2). The cycle repeats until clean or the budget runs out.

**Rules currently enforced:**

| Rule | Where |
|---|---|
| No `page.locator` / `page.getBy*` directly in spec (must go through POM) | Spec |
| No hardcoded persona display names / emails / non-credential fields | Spec + POM |
| No hardcoded persona email passed to `.login(...)` | Spec |
| `personas.X.Y` references must match the actual personas schema | Spec |
| No manual `new XxxPage(page)` POM construction at module scope | Spec |
| No module-level `let xxxPage: XxxPage` declarations | Spec |
| No `beforeEach` login (use persona fixtures) | Spec |
| No bare `{ page, ... }` fixture destructuring | Spec |
| No Jest `test.each()` / `describe.each()` | Spec |
| Feature POMs must NOT be registered as fixtures | Structural |
| Spec POM imports must use `../../../pages/...` (3 levels up) | Structural |
| Spec must import the generated POM and use it | Spec |

Comments, test descriptions, route paths, fixture parameter names, and URL regex patterns are stripped from spec content before the forbidden-string check runs.

### Phase 2 — Slow (real toolchain)

Only runs if Phase 1 is clean. The orchestrator copies the local clone into `/tmp`, symlinks `node_modules`, writes the generated files in, and runs the actual `tsc --noEmit` and `eslint` against it. Errors are fed to a fix agent and the cycle repeats.

If the budget is exhausted in either phase, the spec is still committed and `TaskResult.warned = true` so the trigger can flag the PR.

---

## Review Agent (`src/agents/reviewAgent.ts`)

Triggered by `POST /reviews` when a PR receives a CHANGES_REQUESTED review.

1. Pre-fetches the spec at `ctx.specPath` from the branch
2. Derives the feature from `specPath` (more reliable than parsing the branch name)
3. Agent reads the spec + comments + repo context, fixes spec / POM / personas / fixtures as needed
4. Validates the fixed spec with `validate_typescript`
5. Commits each changed file in `files[]` to the same branch
6. Posts a bot reply on each inline review comment

---

## Persona Auth Model (target test repo)

Provisioned repos ship with `global-setup.ts` that logs in as each persona once and saves storageState to `.playwright-auth/{persona}.json`. The fixtures file exposes:

- `authPage` — fresh `Page` with `AuthPage` constructed. Use only for login-page tests.
- `asPatient` / `asDoctor` / `asAdmin` — pre-authenticated `Page` objects. Use for feature tests; construct feature POMs inline from the persona page.

Feature POMs are **not** registered as fixtures — convention checks fail any spec that tries to.

---

## Output Artifacts

After a successful run, committed to the output repo on branch `qa/{taskId}-{slug}`:

| File | Path | Notes |
|---|---|---|
| Spec | `tests/web/{feature}/{feature}.spec.ts` | Required, exactly 1 |
| POM | `pages/{feature}/{ClassName}.ts` | Required, ≥1 |
| Fixture | `fixtures/index.ts` | Only updated for auth POMs; feature POMs are constructed inline |
| Extra | (any) | Helpers, mock data, config — `role: "extra"` |

---

## Configuration

```bash
cp .env.example .env
npm install
npm run dev
```

| Variable | Description |
|---|---|
| `PORT` | Port to listen on (default: 3000) |
| `GH_APP_ID` | GitHub App identifier (used for installation token) |
| `GH_PRIVATE_KEY` | RSA private key (newlines escaped as `\n`) |
| `GH_INSTALLATION_ID` | Installation ID for token exchange |
| `GITHUB_TOKEN` | Optional PAT — fallback for `localRepo` clone if App vars missing |
| `GITHUB_OWNER` | GitHub org/user that owns the output repo |
| `GITHUB_MAIN_REPO` | Default output repo (e.g. `klikagent-demo-tests`) |
| `KLIKAGENT_TESTS_LOCAL_PATH` | Local clone root (default: `./.klikagent-tests-cache`) |
| `LOCAL_REPO_SYNC_INTERVAL_MS` | Local repo sync interval in ms (default: 300000 = 5 min) |
| `AI_API_KEY` | API key for the AI provider |
| `AI_BASE_URL` | OpenAI-compatible base URL (e.g. `https://api.minimax.io/v1`) |
| `AI_MODEL` | Model ID (e.g. `MiniMax-M2.7`) |
| `AI_MAX_ITERATIONS` | Max tool-call loop iterations per agent run (default: 50) |
| `MAX_SELF_CORRECTION_ATTEMPTS` | Retry budget per self-correction phase (default: 10) |
| `QA_BASE_URL` | Base URL of the target app |
| `PLAYWRIGHT_AUTH_DIR` | Directory for persona storageState files (default: `./.playwright-auth`) |
| `BROWSER_CLI_TIMEOUT` | Timeout per `playwright-cli` call in ms (default: 30000) |
| `DASHBOARD_PASSWORD` | Password for dashboard basic auth |

**AI Provider swap:** The service uses the OpenAI SDK with configurable `baseURL`. Switch providers by updating `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` only — no code changes needed. Currently tested with MiniMax M2.7 at 204k context.

---

## Scripts

```bash
npm run dev        # ts-node + nodemon (auto-reload)
npm run build      # tsc → dist/
npm start          # node dist/webhook/server.js
npm test           # jest
npm run test:watch # jest --watch
```

---

## Testing a Run Locally

```bash
# Trigger QA spec generation
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "42",
    "title": "Test login flow",
    "description": "User can log in with valid credentials and is redirected to dashboard",
    "qaEnvUrl": "https://app.testingwithekki.com",
    "outputRepo": "klikagent-demo-tests",
    "feature": "auth",
    "callbackUrl": "http://localhost:3001/callback/tasks/42/results"
  }'

# Live event stream
open http://localhost:3000/dashboard
```

---

## Project Structure

```
src/
├── agents/
│   ├── explorerAgent.ts        # Browser-driven exploration
│   ├── writerAgent.ts          # Code generation (no browser)
│   ├── reviewAgent.ts          # PR review fix agent
│   ├── qaAgent.ts              # Explorer + Writer orchestration
│   ├── goldenExamples.ts       # Pattern snippets injected into Writer prompt
│   ├── snapshotUtils.ts        # Playwright snapshot helpers
│   ├── prompts/sections.ts     # System prompt fragments per agent phase
│   └── tools/
│       ├── index.ts            # Tool sets per agent (explorer/writer/review/qa)
│       ├── outputTools.ts      # validate_typescript + done() variants
│       ├── repoTools.ts        # get_personas, get_fixtures, list_available_poms, …
│       └── writerTools.ts      # search_codebase, get_file, list_directory (Writer discovery)
├── orchestrator/
│   ├── index.ts                # Routes QATask to generateQaSpecFlow
│   └── generateQaSpecFlow.ts   # branch → self-correction wrapper → commit → PR → callback
├── services/
│   ├── ai.ts                   # OpenAI SDK wrapper, retry, tool loop, token/cost accounting
│   ├── browserTools.ts         # playwright-cli wrapper, multi-tenant sessions, persona switching
│   ├── github.ts               # GitHub App JWT, installation token, branch/commit/PR
│   ├── localRepo.ts            # Local clone of output repo (clone, sync, search, read)
│   ├── codeValidation.ts       # tsc + eslint in a temp clone
│   ├── selfCorrection.ts       # Two-phase loop + parallel per-file fix agents + CI fix
│   ├── personas.ts             # Load personas from output repo config
│   ├── repoProvisioner.ts      # Scaffold new convention-compliant test repos
│   ├── testRepoClone.ts        # MAX_SELF_CORRECTION_ATTEMPTS resolver
│   └── writerContext.ts        # Pre-fetch base + feature context for Writer
├── dashboard/
│   ├── eventBus.ts             # SSE event bus + run-id propagation
│   ├── runStore.ts             # In-memory run history + active-run guard
│   ├── routes.ts               # Dashboard HTTP routes + SSE endpoint
│   └── public/index.html       # Dashboard frontend
├── types/index.ts              # All TypeScript interfaces
├── utils/
│   ├── logger.ts               # Structured logging
│   └── naming.ts               # Branch slug + spec file name conventions
└── webhook/server.ts           # Express entry point
```
