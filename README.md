# KlikAgent — QA Orchestrator

AI-powered QA automation engine. Receives a `QATask` payload, sends an agent to browse the target app, generates a Playwright spec + Page Object Model, validates the output, and opens a draft PR.

Part of a three-repo system:

| Repo | Role |
|---|---|
| `klikagent` | Core orchestrator — this repo |
| `klikagent-github-trigger` | GitHub webhook adapter (HMAC validation, event parsing) |
| `klikagent-demo-tests` | Generated test output, CI runner, GitHub Pages dashboard |

---

## System Architecture

```
GitHub Issue (labeled "klikagent")
         │
         ▼
klikagent-github-trigger          ← HMAC validation, payload parsing
         │
         │  POST /tasks  (QATask)
         ▼
    klikagent  ──────────────────────────────────────────────────────────────────┐
    │                                                                             │
    │  1. Create branch  qa/{taskId}-{slug}                                       │
    │  2. Explorer Agent                                                           │
    │       logs into app → navigates feature → collects locators + flows         │
    │       → ExplorationReport                                                   │
    │  3. Writer Agent                                                             │
    │       reads ExplorationReport + pre-fetched context                         │
    │       → spec.ts + POM.ts                                                    │
    │  4. Self-Correction Loop (max 2 attempts)                                   │
    │       tsc --noEmit  →  feed errors back → retry                            │
    │       Convention checks  →  fail if violated → retry                       │
    │  5. Commit generated files to branch                                        │
    │  6. Open Draft PR in output repo                                            │
    │  7. POST TaskResult → callbackUrl                                           │
    │                                                                             │
    └─────────────────────────────────────────────────────────────────────────────┘
         │
         │  POST /callback/tasks/:id/results  (TaskResult)
         ▼
klikagent-github-trigger          ← comments on issue, transitions label
         │
         ▼
playwright.yml CI runs in klikagent-demo-tests
         │
         │  POST /tasks/:id/results  (CI result)
         ▼
    klikagent                     ← (Phase 3) patch loop on failure
```

---

## Endpoints

All endpoints are on `src/webhook/server.ts`. There is **no** `/webhook/github` route here — HMAC validation and GitHub parsing live in `klikagent-github-trigger`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/tasks` | Trigger QA spec generation. Accepts `QATask`. Returns 202 immediately; processes async. |
| `POST` | `/reviews` | Trigger Review Agent on a CHANGES_REQUESTED PR review. Accepts `ReviewContext`. |
| `POST` | `/tasks/:id/results` | CI reports Playwright test results back. |
| `POST` | `/repos/provision` | Scaffold a new test repo from scratch (creates GitHub repo, seeds context). |
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
  passed: boolean;
  summary: string;
  reportUrl?: string;   // link to draft PR
  metadata?: Record<string, unknown>;
}
```

### ReviewContext — inbound from trigger on CHANGES_REQUESTED

```typescript
interface ReviewContext {
  prNumber: number;
  repo: string;
  outputRepo: string;
  branch: string;
  ticketId: string;
  reviewId: number;
  reviewerLogin: string;
  comments: ReviewComment[];  // inline code review comments
  specPath: string;           // e.g. "tests/web/auth/42.spec.ts"
}
```

### ExplorationReport — internal handoff from Explorer → Writer

```typescript
interface ExplorationReport {
  feature: string;
  visitedRoutes: string[];
  authPersona: string;
  locators: Record<string, Record<string, string>>;  // route → name → generatedCode
  flows: ObservedFlow[];
  missingLocators: MissingLocator[];
  notes: string[];
}
```

---

## Two-Agent Pipeline

### Explorer Agent (`src/agents/explorerAgent.ts`)

**Role:** Browses the target app using real Playwright browser automation. Collects element references and observed user flows. Produces an `ExplorationReport`.

**Tools available:**
- `browser_login(email, password)` — authenticate with a persona
- `browser_navigate(url)` — go to a route
- `browser_list_interactables()` — returns compact CSS selectors (no screenshots, no DOM dump — ~70% fewer tokens)
- `browser_get_aria_snapshot()` — YAML accessibility tree snapshot
- `read_fixtures`, `read_personas`, `read_context_docs` — read repo context
- `exploration_done(report)` — signals completion, returns the `ExplorationReport`

**Output:** `ExplorationReport`

### Writer Agent (`src/agents/writerAgent.ts`)

**Role:** Reads the `ExplorationReport` and pre-fetched context, then generates a Playwright spec and its Page Object Model. Never touches the browser.

**Context pre-fetched before the agent starts (`src/services/writerContext.ts`):**
- `fixtures/index.ts` content
- Personas config
- Context docs (domain knowledge, test patterns)
- Existing POMs in the output repo
- Existing test specs

**Tools available:**
- `validate_typescript` — runs `tsc --noEmit` on proposed code inline
- `qa_done(spec, pom)` — signals completion, returns the generated files

**Output:** spec `.ts` and POM `.ts` file contents

---

## Self-Correction Loop (`src/services/selfCorrection.ts`)

Runs after the Writer agent produces code. Controlled by `MAX_SELF_CORRECTION_ATTEMPTS` (default: 2).

**Check 1 — TypeScript validation:**
```
tsc --noEmit
```
Errors are fed back to the agent as a correction prompt. Agent fixes and retries.

**Check 2 — Convention checks:**

| Check | Rule |
|---|---|
| No hardcoded credentials | Spec must not contain raw email/password strings |
| POM-only locators | `page.locator()` must not appear directly in spec — only in POM |
| POM is used | The generated POM must be imported and used in the spec |

If all attempts fail, the spec is still committed with a warning flag in the `TaskResult`.

---

## Review Agent (`src/agents/reviewAgent.ts`)

Triggered by `POST /reviews` when a PR receives a CHANGES_REQUESTED review.

1. Reads the current spec from the branch
2. Reads all inline review comments
3. Agent: fixes spec + POM based on reviewer feedback
4. Validates fixes with `tsc --noEmit`
5. Commits fixed files to the same branch
6. Posts bot replies to each inline review comment

---

## Output Artifacts

After a successful run, committed to the output repo on branch `qa/{taskId}-{slug}`:

| File | Path |
|---|---|
| Spec | `tests/web/{feature}/{taskId}.spec.ts` |
| POM | `pages/{feature}/{PageName}.ts` |
| Fixture update | `fixtures/index.ts` (new POM import appended) |

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
| `GITHUB_TOKEN` | Personal access token with repo write access |
| `GITHUB_OWNER` | GitHub org/user that owns the output repo |
| `GITHUB_MAIN_REPO` | Default output repo (e.g. `klikagent-demo-tests`) |
| `AI_API_KEY` | API key for the AI provider |
| `AI_BASE_URL` | OpenAI-compatible base URL (e.g. `https://api.minimax.io/v1`) |
| `AI_MODEL` | Model ID (e.g. `MiniMax-M2.7`) |
| `AI_MAX_ITERATIONS` | Max tool-call loop iterations per agent run (default: 20) |
| `MAX_SELF_CORRECTION_ATTEMPTS` | Retry limit for self-correction (default: 2) |
| `QA_BASE_URL` | Base URL of the target app |
| `QA_USER_EMAIL` | Default test account email |
| `QA_USER_PASSWORD` | Default test account password |
| `DASHBOARD_PASSWORD` | Password for dashboard basic auth |

**AI Provider swap:** The service uses the OpenAI SDK with configurable `baseURL`. Switch providers by updating `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` only — no code changes needed.

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

# Check live run events
open http://localhost:3000/dashboard
```

---

## Project Structure

```
src/
├── agents/
│   ├── explorerAgent.ts        # Browser crawl agent
│   ├── writerAgent.ts          # Code generation agent
│   ├── reviewAgent.ts          # PR review fix agent
│   ├── qaAgent.ts              # Explorer + Writer orchestration
│   ├── snapshotUtils.ts        # Playwright snapshot helpers
│   ├── prompts/sections.ts     # System prompts per agent phase
│   └── tools/
│       ├── index.ts            # Tool definitions per phase
│       ├── outputTools.ts      # validate_typescript, done callbacks
│       └── repoTools.ts        # read_fixtures, read_personas, etc.
├── orchestrator/
│   ├── index.ts                # Routes QATask to generateQaSpecFlow
│   └── generateQaSpecFlow.ts   # Main flow: branch → agents → PR → callback
├── services/
│   ├── ai.ts                   # OpenAI-compatible SDK wrapper, retry, tool loop
│   ├── browserTools.ts         # Playwright browser API
│   ├── github.ts               # GitHub API (branch, commit, PR)
│   ├── personas.ts             # Load personas from output repo config
│   ├── repoProvisioner.ts      # Scaffold new test repos
│   ├── selfCorrection.ts       # tsc + convention checks loop
│   ├── localRepo.ts            # Local clone of output repo (reads, search, sync)
│   ├── codeValidation.ts       # tsc + eslint validation in temp clone
│   ├── testRepoClone.ts        # MAX_SELF_CORRECTION_ATTEMPTS config
│   └── writerContext.ts        # Pre-fetch writer context (fixtures, POMs, docs)
├── dashboard/
│   ├── eventBus.ts             # SSE event bus
│   ├── runStore.ts             # In-memory run history
│   ├── routes.ts               # Dashboard HTTP routes + SSE endpoint
│   └── public/index.html       # Dashboard frontend
├── types/index.ts              # All TypeScript interfaces
├── utils/
│   ├── logger.ts               # Structured logging
│   └── naming.ts               # Branch slug, spec file name conventions
└── webhook/server.ts           # Express entry point
```
