# KlikAgent — Agent Instructions

## Dev Commands

```bash
npm run dev      # nodemon + ts-node (auto-reload on changes)
npm run build    # tsc → dist/
npm start        # node dist/webhook/server.js
npm test         # jest
npm run test:watch  # jest --watch
```

## Server Endpoints (Actual)

`src/webhook/server.ts` is the entry point — NOT `/webhook/github`.

| Endpoint | Purpose |
|---|---|
| `POST /tasks` | Trigger QA spec generation (normalized QATask payload) |
| `POST /reviews` | Trigger Review Agent on CHANGES_REQUESTED |
| `POST /tasks/:id/results` | CI reports test results back |
| `GET /health` | Health check |

No HMAC signature validation — the server uses `express.json()`.

## Orchestrator

`src/orchestrator/index.ts` routes all tasks to `generateQaSpecFlow()`. There is only one active flow.

## Label Conventions

| Label | Behaviour |
|---|---|
| `klikagent` | Trigger `generateQaSpecFlow` |
| `status:in-progress` | No-op |
| `scope:web` / `scope:api` / `scope:both` | Controls whether Playwright crawl runs |
| `scope:none` | Skip entirely |
| `rework:*` | Rework mode (parent-aware) |
| `parent:{ticketId}` | Parent ticket for rework subtasks |
| `feature:*` | Feature detection for route resolution |

## Branch / File Naming

- Branch: `qa/{ticketId}-{slug}` — lowercase, hyphens, enforced by `MAX_SLUG_LENGTH=40` in `src/utils/naming.ts`
- Spec path: `tests/web/{feature}/{ticketId}.spec.ts`
- POM path: derived from `Page` class name inside POM content (`pomPathFromContent` in `src/agents/tools/outputTools.ts`)

## Agent Output Format

The QA agent outputs a unified `files[]` array with `role` metadata:
- `role: "spec"` — test file (required, exactly 1)
- `role: "pom"` — Page Object Model (required, at least 1)
- `role: "fixture"` — fixtures/index.ts updates
- `role: "extra"` — any other file (helpers, mock data, config)

## AI Service

Uses OpenAI SDK-compatible API (`src/services/ai.ts`):

```env
AI_API_KEY=...
AI_BASE_URL=https://api.minimax.io/v1
AI_MODEL=MiniMax-M2.7
```

- Retry with exponential backoff on 429/503/529
- Tool cache: duplicate calls within same run return `[ALREADY FETCHED]` — `done()` and `validate_typescript` are never cached
- Max iterations default: 20

## Self-Correction Loop

`src/services/selfCorrection.ts` — `runWithSelfCorrection()` wraps the QA agent with a two-phase validation loop:

1. **Phase 1 (Fast):** Convention checks (regex) + AST validation (`ts.createSourceFile`). Fix agent sees combined errors.
2. **Phase 2 (Slow):** Full `tsc --noEmit` + `eslint` on a temp clone with generated files written in. Fix agent sees real compiler/linter errors.

Max attempts per phase controlled by `MAX_SELF_CORRECTION_ATTEMPTS` env var (default 3). If all attempts fail, the spec is still committed with a warning.

## Crawler — PageSnapshot Format

`src/services/crawler.ts` (if it exists) uses Playwright's `ariaSnapshot({ mode: 'ai' })` (v1.48+) which returns a YAML string, not a JSON object:
- `ariaTree: string` — YAML snapshot
- `testIds: string[]` — raw data-testid attribute values
- `locators: string[]` — pre-computed Playwright locators

## Test Repo Access

`src/services/localRepo.ts` maintains a local clone of the test repo for fast reads and discovery:
- Clone location: `KLIKAGENT_TESTS_LOCAL_PATH` env var, or `./.klikagent-tests-cache/<repoName>/` as default
- Auto-syncs every 5 minutes (`LOCAL_REPO_SYNC_INTERVAL_MS`)
- Runs `npm ci` automatically if `node_modules` is missing

All repo reads (Explorer context, Writer context, Review agent context, CI fix agent context) use the local clone.

## Writer Agent Discovery Tools (Phase 1)

The Writer Agent now has on-demand access to the test repo via three discovery tools:
- `search_codebase(query, filePattern?, path?)` — grep search with 2-line context, 10-match cap
- `get_file(path)` — read any file from the local clone
- `list_directory(path)` — explore directory structure

Context is still pre-fetched (fixtures, personas, golden examples), but the Writer can pull additional utilities and patterns on demand.

## What Was Removed

- No `/webhook/github` endpoint (server uses `/tasks`, `/reviews` instead)
- No `/webhook/jira` endpoint
- No `src/webhook/github/` directory (no `parser.ts`, `router.ts`, `validator.ts`)
- No `src/flows/` directory
- No HMAC signature validation
- No `skeletonAgent.ts` — `scripts/testSkeleton.ts` and `scripts/testEnrichment.ts` reference a non-existent file

## Dependencies

- `openai` — AI service client
- `playwright` — crawler
- `express` — webhook server
- `dotenv` — env loading
- `ts-node` — dev-time execution
- `jest` + `ts-jest` — testing

## Testing a Webhook Locally

```bash
# QA spec generation — POST /tasks (not /webhook/github)
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "KA-42",
    "title": "Login form validation",
    "description": "## Acceptance Criteria\nGiven a user When they submit invalid credentials Then they see an error message",
    "qaEnvUrl": "https://your-qa-environment.com",
    "outputRepo": "owner/klikagent-tests",
    "labels": ["klikagent", "scope:web"]
  }'

# Review Agent — POST /reviews
curl -X POST http://localhost:3000/reviews \
  -H "Content-Type: application/json" \
  -d '{
    "prNumber": 14,
    "branch": "qa/42-login-validation",
    "ticketId": "KA-42",
    "reviewId": 999,
    "reviewerLogin": "qa-engineer",
    "outputRepo": "owner/klikagent-tests"
  }'

# Repo provisioner — POST /repos/provision
curl -X POST http://localhost:3000/repos/provision \
  -H "Content-Type: application/json" \
  -d '{
    "repoName": "myteam-tests",
    "owner": "your-org",
    "qaEnvUrl": "https://qa.yourapp.com",
    "features": ["auth", "billing", "dashboard"],
    "domainContext": "A SaaS platform for managing invoices."
  }'
```

## Test Commands

```bash
npm test           # all tests
npm run build      # TypeScript compile check
```

## Phase Docs

The full requirements and plan are in:
- `klikagent-phase3-requirements.md` — detailed spec
- `klikagent-phase3-plan.md` — implementation plan with branch strategy
- `klikagent-phase2-spec.md` — Phase 2 spec (historical, parts are deleted)
- `OVERVIEW.md` — repository overview (some file references may be stale)
