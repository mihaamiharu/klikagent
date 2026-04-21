# KlikAgent — Agent Instructions

## Dev Commands

```bash
npm run dev      # nodemon + ts-node (auto-reload on changes)
npm run build    # tsc → dist/
npm start        # node dist/webhook/server.js
npm test         # jest
```

## Architecture

Node.js + Express TypeScript webhook listener. Only `/webhook/github` exists — the Phase 2 Jira webhook was removed.

**Entry point:** `src/webhook/server.ts` → `parseGitHubPayload()` → `routeGitHubEvent()` → `orchestrator/`

**Orchestrator (`src/orchestrator/index.ts`):**
- `status:ready-for-qa` label → `generateQaSpecFlow()` (the only active flow)
- `status:in-progress` label → no-op (Flow 1 skeleton generation removed)
- Everything else → skip

The orchestrator delegates to `generateQaSpecFlow` which runs the self-correction loop (QA agent + validation) and commits spec + POM to a `qa/{ticketId}-{slug}` branch, opens a PR, transitions the issue to `status:in-qa`, and comments with token usage.

## Label Conventions

These drive all routing — do not guess:

| Label | Behaviour |
|---|---|
| `status:ready-for-qa` | Trigger `generateQaSpecFlow` |
| `status:in-progress` | No-op |
| `scope:web` / `scope:api` / `scope:both` | Controls whether Playwright crawl runs |
| `scope:none` | Skip entirely |
| `rework:*` | Rework mode (parent-aware) |
| `parent:{ticketId}` | Parent ticket for rework subtasks |
| `feature:*` | Feature detection for route resolution |

## GitHub Webhook Raw Body

`src/webhook/server.ts` uses `express.raw({ type: '*/*' })` on `/webhook/github` because HMAC signature validation needs the raw (unparsed) body buffer. The body is parsed manually after validation. This is a common gotcha — do not switch to `express.json()` or signature validation will break.

## AI Service

Uses OpenAI SDK-compatible API (`src/services/ai.ts`):

```env
AI_API_KEY=...
AI_BASE_URL=https://api.minimax.io/v1
AI_MODEL=MiniMax-M2.7          # default model
```

- Retry with exponential backoff on 429/503/529
- Tool cache: duplicate calls within same run return `[ALREADY FETCHED]` to avoid re-inflating context
- `done()` and `validate_typescript` are never cached
- Max iterations default: 20

## Self-Correction Loop

`src/services/selfCorrection.ts` — `runWithSelfCorrection()` wraps the QA agent + TypeScript validation. Max attempts controlled by `MAX_SELF_CORRECTION_ATTEMPTS` env var (default 2). If all attempts fail, the spec is still committed with a warning in the Jira comment.

## Crawler — PageSnapshot Format

The crawler (`src/services/crawler.ts`) uses Playwright's `ariaSnapshot({ mode: 'ai' })` (v1.48+) which returns a YAML string, not a JSON object. The `PageSnapshot` interface reflects this:
- `ariaTree: string` — YAML snapshot (not an object)
- `testIds: string[]` — raw data-testid attribute values
- `locators: string[]` — pre-computed Playwright locators

## Test Repo Access

`src/services/testRepo.ts` reads from `klikagent-tests` repo via GitHub API. It also clones the repo locally (using `KLIKAGENT_TESTS_LOCAL_PATH=/opt/klikagent-tests` if set) for keyword map and context docs. If both fail, it falls back gracefully.

## Branch / File Naming

- Branch: `qa/{ticketId}-{slug}` — lowercase, hyphens, max 50 chars (function `toBranchSlug` in `src/utils/naming.ts`)
- Spec path: `tests/web/{feature}/{ticketId}.spec.ts`
- POM path: derived from `Page` class name inside the POM content (`pomPathFromContent` in `src/agents/tools/outputTools.ts`)

## What Was Removed from Phase 2 Spec

The Phase 2 spec described Jira webhooks, `src/webhook/jira/`, and `src/flows/`. All of that was deleted:
- No `/webhook/jira` route
- No `src/webhook/jira/` directory
- No `src/flows/` directory
- Jira variables (`JIRA_WEBHOOK_SECRET`, etc.) are not in `.env.example`

## Dependencies to Know

- `openai` — AI service client
- `playwright` — crawler (also available as `@playwright/mcp`)
- `express` — webhook server
- `dotenv` — env loading (loaded at top of `server.ts`)
- `ts-node` — dev-time execution
- `jest` + `ts-jest` — testing

## Testing a Webhook Locally

```bash
# GitHub issues labeled — Flow 2 (generateQaSpecFlow)
curl -X POST http://localhost:3000/webhook/github \
  -H "Content-Type: application/json" \
  -H "x-github-event: issues" \
  -d '{
    "action": "labeled",
    "label": { "name": "status:ready-for-qa" },
    "issue": {
      "number": 42,
      "title": "Login form validation",
      "body": "## Acceptance Criteria\nGiven a user When they submit invalid credentials Then they see an error message",
      "html_url": "https://github.com/owner/repo/issues/42",
      "labels": [{ "name": "status:ready-for-qa" }, { "name": "scope:web" }]
    },
    "repository": { "name": "klikagent-tests", "full_name": "owner/klikagent-tests" }
  }'

# PR review CHANGES_REQUESTED — Review Agent
curl -X POST http://localhost:3000/webhook/github \
  -H "Content-Type: application/json" \
  -H "x-github-event: pull_request_review" \
  -d '{
    "action": "submitted",
    "review": { "id": 999, "state": "CHANGES_REQUESTED", "body": "Tests need more coverage", "user": { "login": "qa-engineer" } },
    "pull_request": { "number": 14, "draft": false, "head": { "ref": "qa/42-login-validation" } },
    "repository": { "name": "klikagent-tests", "full_name": "owner/klikagent-tests" }
  }'
```

## Test Commands

```bash
npm test                    # all tests
npm test -- --watch        # watch mode
npm run build              # TypeScript compile check
```

## Phase Docs

The full requirements and plan are in:
- `klikagent-phase3-requirements.md` — detailed spec
- `klikagent-phase3-plan.md` — implementation plan with branch strategy
- `klikagent-phase2-spec.md` — Phase 2 spec (historical, parts are deleted)