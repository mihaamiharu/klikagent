# KlikAgent — Repository Overview

## What It Is

**KlikAgent** is an AI-powered QA test automation orchestrator. It listens for GitHub webhook events and uses an LLM (Minimax / OpenAI-compatible) to generate, validate, and commit Playwright TypeScript test specs to a separate `klikagent-tests` repo.

---

## Architecture

```
src/
├── webhook/          # Express server + GitHub payload parsing
├── orchestrator/     # Flow routing
├── agents/           # AI agent logic (QA, Review, Enrichment)
│   └── tools/        # Tool definitions for agent function calling
├── services/         # Core services (AI, GitHub, browser, test repo)
├── utils/            # Pure utilities (naming, feature detection, etc.)
└── types/            # TypeScript interfaces
```

---

## Data Flow

```
GitHub Webhook (POST /webhook/github)
    → HMAC signature validation
    → Parse event (issues/labeled or pull_request_review)
    → Route:
        ┌── status:ready-for-qa → generateQaSpecFlow
        └── CHANGES_REQUESTED  → runReviewAgent
```

### `generateQaSpecFlow` (main path)

1. Fetch GitHub issue
2. Detect feature (keyword scoring from title/body + labels)
3. Parse personas from issue body
4. Resolve starting URLs via feature → route map
5. Fetch PR diff from dev repo
6. Create QA branch (`qa/{ticketId}-{slug}`)
7. **Run self-correction loop** (up to `MAX_SELF_CORRECTION_ATTEMPTS`):
   - `runQaAgent` — AI browses the QA app as each persona, writes spec + POMs via tool calls
   - `validateTypescript` — Syntax check
   - `runPlaywrightTest` — Clones `klikagent-tests`, writes spec, runs `playwright test`
   - On failure: send error back to AI, retry
8. Commit spec + POMs to QA branch
9. Open PR in `klikagent-tests`
10. Transition issue label → `status:in-qa`
11. Comment on issue with token usage summary

---

## Agent Tool Loop

The QA agent uses function calling in this required sequence:

```
get_context_docs → get_existing_pom → list_available_poms
    → browser_navigate → browser_snapshot / browser_list_interactables
    → browser_click / browser_fill  (repeat as needed)
    → validate_typescript
    → done()  ← outputs enrichedSpec + poms
```

`browser_list_interactables` returns CSS selectors for clickable/fillable elements. It wraps Playwright CLI commands and manages per-run browser sessions with persona auth state files (`.playwright-sessions/`).

---

## Key Source Files

### Webhook & Routing

| File | Responsibility |
|---|---|
| `src/webhook/server.ts` | Express server, raw body parsing for HMAC validation, async dispatch |
| `src/webhook/github/parser.ts` | Extract `TriggerContext` / `ReviewContext` from webhook payloads |
| `src/webhook/github/router.ts` | Route parsed context to orchestrator or Review Agent |
| `src/webhook/validator.ts` | HMAC-SHA256 signature check (`x-hub-signature-256`) |

### Orchestration

| File | Responsibility |
|---|---|
| `src/orchestrator/index.ts` | Central router; `status` field determines which flow runs |
| `src/orchestrator/generateQaSpecFlow.ts` | Full QA spec generation pipeline (steps 1–11 above) |

### Agents

| File | Responsibility |
|---|---|
| `src/agents/qaAgent.ts` | QA agent system prompt + tool calling loop; browses app as personas |
| `src/agents/reviewAgent.ts` | Handles `CHANGES_REQUESTED` reviews; fixes spec/POM, replies to comments |
| `src/agents/tools/index.ts` | Central tool export |
| `src/agents/tools/outputTools.ts` | `done()`, `validate_typescript` tool definitions |
| `src/agents/tools/repoTools.ts` | `get_context_docs`, `get_fixtures`, `list_available_poms` |
| `src/agents/tools/qaTools.ts` | Browser tools (delegates to `browserToolsCli`) |

### Services

| File | Responsibility |
|---|---|
| `src/services/ai.ts` | Agent loop, tool dispatch, exponential backoff on 429/503/529, token tracking, duplicate-call caching |
| `src/services/browserToolsCli.ts` | Playwright CLI wrapper; browser session + persona auth state management |
| `src/services/selfCorrection.ts` | Retry loop: agent → TypeScript check → Playwright test |
| `src/services/testRepoClone.ts` | API-based clone of `klikagent-tests`; runs `playwright test` locally |
| `src/services/testRepo.ts` | Reads config, POMs, fixtures, keyword/route maps from test repo |
| `src/services/github.ts` | GitHub REST API: PRs, issues, branches, file reads/writes |
| `src/services/personas.ts` | Parse persona credentials from env vars |
| `src/services/issues.ts` | GitHub Issues wrapper (fetch, comment, label transitions) |

### Utils

| File | Responsibility |
|---|---|
| `src/utils/naming.ts` | Branch slugs, spec filenames, PR titles (with char-limit enforcement) |
| `src/utils/featureDetector.ts` | Keyword scoring (title: 3× weight, body: 1×); label override |
| `src/utils/pagesResolver.ts` | Map feature name → starting QA URLs via route map |
| `src/utils/diffAnalyzer.ts` | Fetch raw diff string from dev PR |
| `src/utils/personaUtils.ts` | Parse persona names from issue body |
| `src/utils/logger.ts` | Structured logging: `log('INFO|WARN|ERROR|SKIP|ROUTE', message)` |

---

## Key Services — Detail

### `src/services/ai.ts`
- OpenAI-compatible SDK agent loop
- Tool result caching: duplicate calls return `[ALREADY FETCHED]` (except `done()` and `validate_typescript`)
- Exponential backoff retry on 429 / 503 / 529 responses
- Tracks prompt + completion tokens across all iterations

### `src/services/browserToolsCli.ts`
- Wraps `playwright-cli` shell commands
- Manages one browser session per KlikAgent run
- Persona auth: email/password login → saves Playwright state to `.playwright-sessions/{persona}.json`
- Exposes: `browser_navigate`, `browser_click`, `browser_fill`, `browser_snapshot`, `browser_list_interactables`, `browser_close`

### `src/services/selfCorrection.ts`
- Runs: `runQaAgent` → `validateTypescript` → `runPlaywrightTest`
- On failure: appends error to conversation, increments attempt counter
- Falls through and commits with a warning comment if all attempts exhausted

### `src/services/testRepoClone.ts`
- Downloads `klikagent-tests` files via GitHub API (no git binary needed)
- Caches with `.klikagent-sha` for cache invalidation
- Writes the spec under test to the clone, runs `npm install && playwright test`

---

## GitHub Trigger Labels

| Label | Effect |
|---|---|
| `status:ready-for-qa` | Triggers QA spec generation (main flow) |
| `status:in-progress` | No-op (Phase 1 skeleton removed) |
| `scope:web` / `scope:api` / `scope:both` / `scope:none` | Controls what Playwright crawls |
| `feature:*` | Overrides auto feature detection |
| `rework:*` + `parent:{ticketId}` | Refinement mode on an existing spec |

---

## Tests

**Framework:** Jest + ts-jest

| Test File | Covers |
|---|---|
| `src/utils/naming.test.ts` | Branch slugs, filenames, char limits |
| `src/utils/featureDetector.test.ts` | Keyword scoring, label override |
| `src/services/ai.test.ts` | Agent loop, token tracking |
| `src/services/selfCorrection.test.ts` | Retry logic |
| `src/services/browserToolsCli.test.ts` | CLI execution mocking |
| `src/agents/qaAgent.test.ts` | Agent system prompt |
| `src/agents/tools/qaTools.test.ts` | Browser tool mocking |
| `src/webhook/validator.test.ts` | HMAC signature validation |
| `src/webhook/github/parser.test.ts` | Payload parsing |
| `src/services/testRepo.test.ts` | Test repo read operations |

---

## Configuration

### Environment Variables (key ones)

```bash
# Server
PORT=3000

# GitHub
GITHUB_WEBHOOK_SECRET=...
GITHUB_TOKEN=...             # Needs: contents r/w, pull-requests r/w, issues
GITHUB_OWNER=...
GITHUB_MAIN_REPO=...         # Dev repo (where features live)
GITHUB_TEST_REPO=klikagent-tests

# Self-correction
KLIKAGENT_TESTS_LOCAL_PATH=/opt/klikagent-tests
MAX_SELF_CORRECTION_ATTEMPTS=2

# AI (OpenAI-compatible)
AI_API_KEY=...
AI_BASE_URL=https://api.minimax.io/v1
AI_MODEL=MiniMax-M2.7
AI_MAX_TOKENS=32768
AI_MAX_ITERATIONS=30

# QA Environment
QA_BASE_URL=https://your-qa-environment.com

# Personas
QA_PATIENT_EMAIL=...    QA_PATIENT_PASSWORD=...
QA_DOCTOR_EMAIL=...     QA_DOCTOR_PASSWORD=...
QA_ADMIN_EMAIL=...      QA_ADMIN_PASSWORD=...
```

### NPM Scripts

```bash
npm run dev        # nodemon + ts-node (auto-reload)
npm run build      # tsc → dist/
npm start          # node dist/webhook/server.js
npm test           # jest
npm run test:watch # jest --watch
```

### Docker

Multi-stage build (Node 20 Alpine → Debian Bookworm slim) with Playwright Chromium installed. Exposes port 3000 → 4000 in `docker-compose.yml`.

---

## Current Branch: `feat/list-interactables`

Recent commits add `browser_list_interactables`:

| Commit | Description |
|---|---|
| `9de51d6` | Tests for `browser_list_interactables` |
| `7bb54ee` | Feature implementation with CSS selectors |
| `0c3c66a` | Fix `getCliBase()` path resolution, remove session reuse |
| `c95a0cd` | Save state to `__dirname/.playwright-sessions`, use fill+click for login |
| `f3276b0` | Improve error messages for navigation, fix snapshot check |
