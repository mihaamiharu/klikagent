# KlikAgent — Phase 2: Webhook Listener Spec

## Overview

Build a Node.js + Express webhook listener that receives Jira events and routes them to the correct flow handler. This is the entry point of the entire KlikAgent automation pipeline.

---

## Repo

- **Repo name:** `klikagent` (separate from `klikagent-tests`)
- **Language:** TypeScript
- **Runtime:** Node.js
- **Framework:** Express

---

## Project Structure

```
klikagent/
├── src/
│   ├── webhook/
│   │   ├── server.ts              # Express app — mounts /webhook/jira + /webhook/github
│   │   ├── validator.ts           # Signature/secret validation (Jira + GitHub)
│   │   ├── jira/
│   │   │   ├── parser.ts          # Extract TriggerContext from Jira payload
│   │   │   └── router.ts          # Route TriggerContext to correct flow
│   │   └── github/
│   │       ├── parser.ts          # Parse pull_request_review + workflow_run events
│   │       └── router.ts          # Route to review agent or flow3
│   ├── flows/
│   │   ├── flow1.ts               # In Progress → generate tests (stub)
│   │   ├── flow2.ts               # Ready for QA → build check + regression (stub)
│   │   └── flow3.ts               # Done → parse results + post summary (stub)
│   ├── agents/
│   │   └── reviewAgent.ts         # Handle PR review → rework flow (stub)
│   ├── utils/
│   │   ├── logger.ts              # Shared logger
│   │   └── githubApi.ts           # GitHub REST API helpers
│   └── types/
│       └── index.ts               # All shared TypeScript types
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.11.0",
    "typescript": "^5.3.3",
    "ts-node": "^10.9.2",
    "nodemon": "^3.0.2"
  }
}
```

**Scripts:**
```json
{
  "dev": "nodemon --exec ts-node src/webhook/server.ts",
  "build": "tsc",
  "start": "node dist/webhook/server.js"
}
```

---

## Environment Variables

```env
# .env.example
PORT=3000

# Jira
JIRA_WEBHOOK_SECRET=your_jira_webhook_secret_here
JIRA_BASE_URL=https://yourworkspace.atlassian.net
JIRA_PROJECT_KEY=KA

# GitHub
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret_here
GITHUB_TOKEN=your_github_pat_here
GITHUB_OWNER=your_github_username_or_org
GITHUB_TEST_REPO=klikagent-tests
```

---

## Types — `src/types/index.ts`

```typescript
// ─── Jira ─────────────────────────────────────────────────────────────────────

// Raw Jira webhook payload (subset of fields we care about)
export interface JiraWebhookPayload {
  webhookEvent: string;           // e.g. "jira:issue_updated"
  issue: {
    key: string;                  // e.g. "KA-42"
    self: string;                 // full API URL to the issue
    fields: {
      summary: string;
      status: {
        name: string;             // e.g. "In Progress"
      };
      project: {
        key: string;              // e.g. "KA"
      };
      labels: string[];           // e.g. ["scope:web", "scope:api"]
      description?: string;
      issuetype: {
        name: string;             // e.g. "Story", "Bug", "Rework"
      };
      parent?: {
        key: string;              // e.g. "KA-40" — parent ticket if exists
      };
    };
  };
  changelog?: {
    items: Array<{
      field: string;              // e.g. "status"
      fromString: string;         // previous status name
      toString: string;           // new status name
    }>;
  };
}

// Clean handoff object passed to the orchestrator (Phase 3)
export interface TriggerContext {
  flow: 1 | 2 | 3;
  ticketId: string;               // e.g. "KA-42"
  ticketSummary: string;
  ticketUrl: string;              // e.g. "https://yourworkspace.atlassian.net/browse/KA-42"
  status: string;                 // the new status that triggered the event
  previousStatus: string;         // the status it came from
  project: string;                // Jira project key
  labels: string[];               // all labels on the ticket, passed raw for Phase 3 scope guard
  scope: 'web' | 'api' | 'both' | 'none';  // parsed from labels
  isRework: boolean;              // true if issue type === "Rework"
  parentTicketId?: string;        // parent ticket key if present (e.g. "KA-40")
  // Flow 3 only — populated from workflow_run event
  runId?: number;                 // GitHub Actions run ID
  runType?: 'new-tests' | 'affected' | 'smoke';  // which workflow completed
  timestamp: string;              // ISO 8601
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

// Incoming pull_request_review webhook payload (subset)
export interface GitHubPRReviewPayload {
  action: string;                 // e.g. "submitted"
  review: {
    id: number;
    state: string;                // e.g. "CHANGES_REQUESTED", "APPROVED"
    user: {
      login: string;
    };
    body: string | null;
  };
  pull_request: {
    number: number;
    draft: boolean;
    head: {
      ref: string;                // branch name e.g. "qa/KA-42-login-validation"
    };
  };
  repository: {
    name: string;                 // e.g. "klikagent-tests"
    full_name: string;            // e.g. "yourorg/klikagent-tests"
  };
}

// Incoming workflow_run webhook payload (subset)
export interface GitHubWorkflowRunPayload {
  action: string;                 // e.g. "completed"
  workflow_run: {
    id: number;
    name: string;                 // e.g. "selective.yml" or "smoke.yml"
    conclusion: string;           // e.g. "success", "failure"
    workflow_id: number;
  };
  repository: {
    name: string;
    full_name: string;
  };
}

// GitHub Actions run inputs — fetched via API, not in webhook payload
export interface WorkflowRunInputs {
  ticketId: string;               // e.g. "KA-42"
  runType: 'new-tests' | 'affected' | 'smoke';
}

// Clean handoff object for the Review Agent
export interface ReviewContext {
  prNumber: number;
  repo: string;                   // e.g. "klikagent-tests"
  branch: string;                 // e.g. "qa/KA-42-login-validation"
  ticketId: string;               // extracted from branch name
  reviewId: number;
  reviewerLogin: string;
  comments: string[];             // review comment bodies
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export type FlowHandler = (context: TriggerContext) => Promise<void>;
export type ReviewHandler = (context: ReviewContext) => Promise<void>;
```

---

## Jira Board Status → Flow Mapping

| Jira Status (toString) | Flow | Action |
|---|---|---|
| `In Progress` | Flow 1 | Generate tests for the ticket |
| `Ready for QA` | Flow 2 | Check CI build → if green run regression, if red comment on Jira |
| `Done` | Flow 3 | Parse test results → post summary to Jira |
| `In QA` | — | No trigger. Agent-owned state, ignore incoming events for this status |

---

## `src/webhook/server.ts`

- Create an Express app
- Mount two routes:
  - `POST /webhook/jira` — Jira events
  - `POST /webhook/github` — GitHub events (`pull_request_review`, `workflow_run`)
- For both routes: call `validatePayload()` first — if invalid return `401`
- Distinguish GitHub event type via `x-github-event` header
- Call the appropriate parser for the event type
- If result is `null` (skipped), return `200 { skipped: true }`
- Hand off to the appropriate router asynchronously — always return `200` immediately
- Add basic request logging (method, path, event type, timestamp)
- Listen on `PORT` from env

---

## `src/webhook/validator.ts`

### Function: `validatePayload(req: Request, source: 'jira' | 'github'): boolean`

**For Jira:**
- Read `JIRA_WEBHOOK_SECRET` from env
- Jira signs with `x-hub-signature` header (SHA-256 HMAC)
- Compute HMAC of raw body, compare with `crypto.timingSafeEqual`

**For GitHub:**
- Read `GITHUB_WEBHOOK_SECRET` from env
- GitHub signs with `x-hub-signature-256` header (SHA-256 HMAC, prefixed `sha256=`)
- Strip the `sha256=` prefix before comparing

**Both:**
- Return `true` if valid, `false` if invalid or header missing
- If the relevant secret env var is not set, log a warning and skip validation (dev mode only)

> **Note:** Express must use `express.raw({ type: 'application/json' })` on both routes to access the raw body for HMAC. Parse JSON manually after verification.

---

## `src/webhook/jira/parser.ts`

### Function: `parseJiraPayload(payload: JiraWebhookPayload): TriggerContext | null`

**Return `null` (skip silently) if:**
- `webhookEvent` is not `jira:issue_updated`
- No `changelog` present
- No status change in `changelog.items` (field !== `'status'`)
- `issue.fields.project.key` does not match `JIRA_PROJECT_KEY` env var
- Labels include `scope:none`
- New status (`toString`) is not one of the mapped trigger statuses (`In Progress`, `Ready for QA`, `Done`)

**If valid, return `TriggerContext`:**
- Parse `scope` from labels: `scope:web` → `'web'`, `scope:api` → `'api'`, `scope:both` → `'both'`, none → `'none'` (return `null`)
- Determine `flow` from the new status name
- Build `ticketUrl` as `${JIRA_BASE_URL}/browse/${issue.key}`
- Set `isRework`: `issue.fields.issuetype.name === 'Rework'`
- Set `parentTicketId`: `issue.fields.parent?.key ?? undefined`
- Pass `labels` through **raw and unfiltered** — Phase 3 scope guard reads them directly
- Set `timestamp` to `new Date().toISOString()`

**Log every skipped event with a reason:**
```
[SKIP] KA-42 — reason: scope:none label present
[SKIP] KA-43 — reason: status "In QA" has no mapped flow
[SKIP] KA-44 — reason: not a status change event
```

---

## `src/webhook/jira/router.ts`

### Function: `routeToFlow(context: TriggerContext): Promise<void>`

- Switch on `context.flow`
- Call the appropriate flow handler: `flow1(context)`, `flow2(context)`, `flow3(context)`
- Wrap in try/catch — log errors but do not throw (server must stay up)
- Log the routing decision:
```
[ROUTE] KA-42 → Flow 1 (In Progress, scope:web)
[ROUTE] KA-43 → Flow 2 (Ready for QA, scope:api)
```

---

## `src/webhook/github/parser.ts`

### Function: `parseGitHubPayload(eventType: string, payload: unknown): TriggerContext | ReviewContext | null`

Handles two event types:

---

### Event: `pull_request_review`

Cast payload to `GitHubPRReviewPayload`.

**Return `null` if:**
- `action` is not `'submitted'`
- `review.state` is not `'CHANGES_REQUESTED'`
- `pull_request.draft === true` — skeleton PRs are always draft, never route

**If valid, build `ReviewContext`:**
- Extract `ticketId` from branch name using regex: `/^qa\/(KA-\d+)-/`
  - e.g. `qa/KA-42-login-validation` → `KA-42`
  - If branch doesn't match pattern → return `null`, log skip reason
- Map `review.body` + any inline comment bodies to `comments[]`

```
[SKIP] PR #12 — reason: draft PR, skeleton branch
[SKIP] PR #13 — reason: branch name doesn't match qa/KA-* pattern
[ROUTE] PR #14 → Review Agent (KA-42, CHANGES_REQUESTED)
```

---

### Event: `workflow_run`

Cast payload to `GitHubWorkflowRunPayload`.

**Return `null` if:**
- `action` is not `'completed'`
- `workflow_run.name` is not `'selective.yml'` or `'smoke.yml'`

**If valid:**
- Call `fetchWorkflowRunInputs(runId)` from `githubApi.ts` to recover `ticketId` and `runType`
  - This is a `GET /repos/{owner}/{repo}/actions/runs/{runId}` call — the webhook payload does NOT include dispatch inputs
- Build `TriggerContext` with:
  - `flow: 3`
  - `ticketId` and `runType` from the API response
  - `runId` from `workflow_run.id`
  - `scope`, `labels`, `isRework` left as defaults (`'none'`, `[]`, `false`) — Phase 3 will re-fetch ticket if needed

```
[SKIP] workflow_run — reason: not selective.yml or smoke.yml
[ROUTE] workflow_run → Flow 3 (KA-42, runType: smoke, runId: 9876543)
```

---

## `src/webhook/github/router.ts`

### Function: `routeGitHubEvent(result: TriggerContext | ReviewContext): Promise<void>`

- If result has `flow` field → it's a `TriggerContext` → call `flow3(context)`
- If result has `prNumber` field → it's a `ReviewContext` → call `reviewAgent(context)`
- Wrap in try/catch — log errors, never throw
- Log the routing decision

---

## `src/utils/githubApi.ts`

### Function: `fetchWorkflowRunInputs(runId: number): Promise<WorkflowRunInputs>`

- Call `GET https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_TEST_REPO}/actions/runs/{runId}`
- Auth: `Authorization: Bearer ${GITHUB_TOKEN}`
- Extract `ticketId` and `runType` from the response's triggering workflow inputs
- Throw if inputs are missing or malformed — caller handles the error

---

## Flow Stubs + Review Agent Stub

All stubs should:
- Accept the appropriate context as the only argument
- Log that it was called with the ticket ID / PR number
- Log a `TODO` message for what Phase 3 will implement
- Return `Promise<void>`

### `src/flows/flow1.ts`
```
TODO (Phase 3): Read full ticket via Jira MCP → generate Playwright tests → commit to branch qa/KA-XX-short-summary → open PR (draft) → comment on Jira
```

### `src/flows/flow2.ts`
```
TODO (Phase 3): Check latest CI build via GitHub API → if green move ticket to "In QA" + trigger selective.yml + smoke.yml → if red comment on Jira with build link
```

### `src/flows/flow3.ts`
```
TODO (Phase 3): Fetch workflow run results via GitHub API (runId from TriggerContext) → build pass/fail summary → post as Jira comment → if all pass move ticket to "Done"
```

### `src/agents/reviewAgent.ts`
```
TODO (Phase 3): Read CHANGES_REQUESTED review comments → prompt Claude to revise failing tests → commit fixes to same branch → re-request review → comment on Jira ticket
```

---

## Logging Convention

```typescript
// src/utils/logger.ts
export const log = (
  level: 'INFO' | 'SKIP' | 'ROUTE' | 'ERROR' | 'WARN' | 'REVIEW',
  message: string
) => {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
};
```

Use this consistently across all files.

---

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Testing the Webhook Locally

### Jira — ticket moves to In Progress (Flow 1)
```bash
curl -X POST http://localhost:3000/webhook/jira \
  -H "Content-Type: application/json" \
  -d '{
    "webhookEvent": "jira:issue_updated",
    "issue": {
      "key": "KA-1",
      "self": "https://yourworkspace.atlassian.net/rest/api/3/issue/KA-1",
      "fields": {
        "summary": "Login form validation",
        "status": { "name": "In Progress" },
        "project": { "key": "KA" },
        "labels": ["scope:web"],
        "issuetype": { "name": "Story" }
      }
    },
    "changelog": {
      "items": [{ "field": "status", "fromString": "Backlog", "toString": "In Progress" }]
    }
  }'
```
Expected logs:
```
[INFO] POST /webhook/jira
[ROUTE] KA-1 → Flow 1 (In Progress, scope:web, isRework: false)
[INFO] [Flow 1] KA-1 triggered — TODO: Phase 3 will generate tests
```

---

### GitHub — PR review CHANGES_REQUESTED (Review Agent)
```bash
curl -X POST http://localhost:3000/webhook/github \
  -H "Content-Type: application/json" \
  -H "x-github-event: pull_request_review" \
  -d '{
    "action": "submitted",
    "review": {
      "id": 999,
      "state": "CHANGES_REQUESTED",
      "user": { "login": "reviewer-jane" },
      "body": "Test coverage missing for error state"
    },
    "pull_request": {
      "number": 14,
      "draft": false,
      "head": { "ref": "qa/KA-1-login-form-validation" }
    },
    "repository": {
      "name": "klikagent-tests",
      "full_name": "yourorg/klikagent-tests"
    }
  }'
```
Expected logs:
```
[INFO] POST /webhook/github (pull_request_review)
[ROUTE] PR #14 → Review Agent (KA-1, CHANGES_REQUESTED)
[REVIEW] KA-1 PR #14 triggered — TODO: Phase 3 will handle rework
```

---

### GitHub — workflow_run completed (Flow 3)
```bash
curl -X POST http://localhost:3000/webhook/github \
  -H "Content-Type: application/json" \
  -H "x-github-event: workflow_run" \
  -d '{
    "action": "completed",
    "workflow_run": {
      "id": 9876543,
      "name": "smoke.yml",
      "conclusion": "success",
      "workflow_id": 111
    },
    "repository": {
      "name": "klikagent-tests",
      "full_name": "yourorg/klikagent-tests"
    }
  }'
```
Expected logs:
```
[INFO] POST /webhook/github (workflow_run)
[INFO] Fetching inputs for run 9876543 via GitHub API...
[ROUTE] workflow_run → Flow 3 (KA-1, runType: smoke, runId: 9876543)
[INFO] [Flow 3] KA-1 triggered — TODO: Phase 3 will post results
```

---

## VPS Deployment

### Stack
- **PM2** — process manager, keeps service alive + auto-restarts on crash
- **Nginx** — reverse proxy, forwards port 80/443 → Express on port 3000
- **Certbot** — free SSL via Let's Encrypt (required by Jira Cloud webhooks)

---

### PM2 Setup

Install PM2 globally:
```bash
npm install -g pm2
```

Start the service:
```bash
pm2 start dist/webhook/server.js --name klikagent
pm2 save
pm2 startup  # auto-start on VPS reboot
```

Useful commands:
```bash
pm2 status          # check if running
pm2 logs klikagent  # tail logs
pm2 restart klikagent
```

---

### Nginx Config

Create `/etc/nginx/sites-available/klikagent`:

```nginx
server {
    listen 80;
    server_name klikagent.yourdomain.com;  # replace with your domain

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable it:
```bash
ln -s /etc/nginx/sites-available/klikagent /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

---

### SSL with Certbot

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d klikagent.yourdomain.com
```

Certbot auto-updates the Nginx config with HTTPS and sets up auto-renewal.

Final webhook URL to paste into Jira:
```
https://klikagent.yourdomain.com/webhook/jira
```

---

### Deployment Flow (after initial setup)

```bash
git pull origin main
npm install
npm run build
pm2 restart klikagent
```

---

## What Phase 3 Will Replace

The flow stubs and review agent stub are the **only files Phase 3 touches**:
- `src/flows/flow1.ts`
- `src/flows/flow2.ts`
- `src/flows/flow3.ts`
- `src/agents/reviewAgent.ts`

Everything else in Phase 2 stays as-is. `TriggerContext` and `ReviewContext` are the contracts between Phase 2 and Phase 3.
