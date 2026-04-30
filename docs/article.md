# How I Built an AI Agent That Writes Playwright Tests From a GitHub Issue

I've been building KlikAgent — an AI-powered QA automation system that turns a GitHub issue into a Playwright test. Label an issue, and a few minutes later a draft PR appears in your test repository with a working spec and a Page Object Model, ready for review.

This article walks through how it works, why I made the architectural choices I did, and where it currently falls short. The full source is on GitHub: [klikagent](https://github.com/mihaamiharu/klikagent).

---

## 1. The Problem

QA test coverage is the thing every engineering team agrees is important and nobody has enough of.

It's not that engineers don't care. It's that writing tests is the work that happens *after* the real work is done. The feature is shipped, the PR is merged, the next ticket is already open — and the test suite quietly falls further behind.

The problem compounds in fast-moving teams. A new feature gets a happy-path test if you're lucky. Edge cases, role-based access, error states — those get filed as "we should add tests for this" and live in a backlog nobody revisits. Meanwhile, the QA engineer who *wants* to write thorough coverage is spending their time on manual regression instead of automation, because automation requires time they don't have.

I've seen this pattern on every team I've worked on. The test suite isn't bad because people are lazy. It's bad because writing good Playwright tests — real ones, with proper Page Object Models, fixture-based personas, typed locators — takes meaningful time and requires context about how the app actually behaves at runtime. You have to log in, navigate, find the right selectors, understand what the feature is supposed to do, then translate all of that into maintainable code.

That's a lot of steps before you write a single `expect()`.

What if an agent could do the boring parts? Log into the app, navigate to the feature, collect the locators, observe the flows — and hand that report to a code generation agent that writes the spec and Page Object Model while you're doing something else?

That's the question that led me to build KlikAgent.

---

## 2. The Idea

The idea is simple on paper: a GitHub issue becomes a Playwright test.

You create an issue describing what needs to be tested — the acceptance criteria, which feature, which environment. You add a label. A few minutes later, a draft PR appears in your test repository with a working spec and a Page Object Model, ready for review.

No context-switching into a test file. No manually hunting for selectors. No boilerplate. Just a PR you can read, tweak if needed, and merge.

Here's what that looks like in practice. A QA engineer opens an issue on GitHub:

```
Title: Test patient login flow

Acceptance Criteria:
- Patient can log in with valid credentials
- Redirected to dashboard after login
- Invalid credentials show an error message

Feature: auth
QA Environment: https://app.testingwithekki.com
```

They add the label `klikagent`. That's the entire trigger.

Behind the scenes, an AI agent logs into the app as a patient, navigates to the login page, collects the element references, observes what happens on success and failure, then hands everything to a second agent that writes the code. The result gets committed to a branch, TypeScript-validated, checked against your team's conventions, and opened as a draft PR — all before the engineer has finished their coffee.

The draft PR contains:

- **A spec file** — `tests/web/auth/test-patient-login-flow.spec.ts` — with test cases for the happy path and the error state
- **A Page Object Model** — `pages/auth/AuthPage.ts` — with typed locators and action methods
- **A fixture update** — `fixtures/index.ts` — so the POM is available across the test suite

The engineer reviews it, adjusts anything that looks off, and merges. CI runs the tests. The dashboard updates.

That's the loop. The agent handles the mechanical work — exploration, boilerplate, wiring — and the human handles the judgment call of whether the output is correct.

---

## 3. The Trigger Layer

The first question when designing KlikAgent was: where does the task come from?

The obvious answer is GitHub — that's where issues live. But hardwiring GitHub event parsing into the core orchestrator would mean every future integration (Jira, Linear, a CLI script) requires touching the engine. That's the wrong coupling.

So the trigger lives in its own service: **klikagent-github-trigger**. Its only job is to translate GitHub-specific events into a neutral `QATask` interface and forward them to the orchestrator. The orchestrator never knows it came from GitHub.

The `QATask` contract looks like this:

```typescript
interface QATask {
  taskId: string        // GitHub issue number, e.g. "42"
  title: string
  description: string   // acceptance criteria from the issue body
  qaEnvUrl: string      // e.g. "https://app.testingwithekki.com"
  outputRepo: string    // where to commit the generated tests
  feature?: string      // e.g. "auth" — routes the spec to tests/web/auth/
  callbackUrl?: string  // where to POST the result when done
}
```

When a GitHub issue is labeled `klikagent`, the trigger service receives the webhook event, validates the HMAC-SHA256 signature, parses the issue body, and maps it to a `QATask`. It then saves a reference to the originating issue and forwards the task to the orchestrator with a `callbackUrl` pointing back to itself.

That callback is important. When the orchestrator finishes — spec generated, PR opened — it POSTs a `TaskResult` to the `callbackUrl`. The trigger service receives it, looks up the original issue, comments with the PR link, and transitions the label from `klikagent` to `status:in-qa`. The issue stays in sync with what's happening in the test repo without the orchestrator knowing anything about GitHub issues.

```
GitHub issue labeled
        ↓
klikagent-github-trigger
  validates HMAC signature
  parses issue → QATask
  POST /tasks to orchestrator (with callbackUrl)
        ↓
klikagent orchestrator runs...
        ↓
POST /callback/tasks/:id/results (TaskResult)
        ↓
klikagent-github-trigger
  comments on issue with PR link
  transitions label → status:in-qa
```

The same pattern handles PR review feedback. When a reviewer submits CHANGES_REQUESTED on a generated PR, the trigger parses the inline comments, extracts the branch and ticket ID, and forwards a `ReviewContext` to the orchestrator's `/reviews` endpoint. The orchestrator fixes the spec and commits back to the same branch — no new PR needed.

The boundary is clean: everything GitHub-shaped stops at the trigger service. Everything past that point speaks `QATask`.

---

## 4. The Two-Agent Pipeline

The core of KlikAgent is two agents with a clean handoff between them. They have different jobs, different tools, and they never run at the same time.

**The Explorer** goes first. It has access to a real Playwright browser and a set of browser tools. It logs into the target app using a test persona, navigates to the feature routes, and collects everything the Writer will need: element references, observed user flows, what happens on success, what happens on failure. When it's done, it calls `exploration_done()` with a structured `ExplorationReport`.

```typescript
interface ExplorationReport {
  feature: string
  visitedRoutes: string[]
  authPersona: string
  locators: Record<string, Record<string, string>>  // route → name → generatedCode
  flows: ObservedFlow[]
  notes: string[]
}
```

The Explorer never writes code. It just observes and reports.

**The Writer** goes second. It never touches the browser. Instead, it receives the `ExplorationReport` plus a pre-fetched `WriterContext` — the existing fixtures, personas config, context docs, and any POMs already in the repo. With all of that in hand, it generates the spec and Page Object Model, then calls `qa_done()`.

The reason for the split is practical. Browser automation is expensive — each navigation, each snapshot, each interaction burns tokens and takes time. Code generation is cheap by comparison. If you put both jobs in one agent, it either browses too little (misses locators) or browses too much (burns your budget on redundant snapshots while also writing code).

Separating them lets each agent do exactly one thing well. The Explorer browses until it has enough signal. The Writer generates from a complete, structured report — no mid-generation "let me go check one more thing."

### How the browser tools work

Under the hood, the Explorer uses **playwright-cli** — a lightweight CLI wrapper around Playwright that maintains a persistent browser session across sequential tool calls. This is a deliberate choice over the Playwright MCP server: playwright-cli keeps state between calls without spawning a new browser process each time, which matters when you're navigating across multiple routes in a single agent run.

Instead of taking screenshots or dumping raw HTML, `browser_list_interactables()` returns a **YAML accessibility tree** with element refs:

```yaml
- textbox "Email" [ref=e3]
- textbox "Password" [ref=e4]
- button "Sign In" [ref=e7]
```

The agent uses these refs to interact with elements. Every `browser_click` and `browser_fill` automatically returns `generatedCode` — the exact Playwright locator string emitted by playwright-cli for that action. For elements the agent observes but doesn't interact with, it calls `browser_generate_locator(ref)` to resolve the ref into a locator.

The Explorer collects these `generatedCode` values as it navigates and packages them into the `ExplorationReport`. The Writer receives them as ready-to-use locator strings — no guessing, no hallucinated selectors.

The handoff point — the `ExplorationReport` — is where the two agents meet. It's a typed contract. The Explorer is responsible for filling it completely. The Writer is responsible for trusting it and generating from it. Neither agent needs to know how the other works.

---

## 5. Self-Correction

Generating code with an LLM is easy. Generating code you can actually trust to land in a repository is harder.

The first draft from the Writer agent is a starting point, not a finished product. It might have TypeScript errors — wrong import paths, missing types, incorrect method signatures. It might also violate conventions your team has agreed on, like using `page.locator()` directly in a spec instead of going through the Page Object Model.

Catching these problems before the code is committed is the job of the self-correction loop.

After the Writer calls `qa_done()`, two checks run automatically.

**Check 1 — TypeScript validation:**

```bash
tsc --noEmit
```

If there are type errors, they get fed back to the agent as a correction prompt. The agent sees the exact compiler output, fixes the code, and the check runs again. This repeats up to a configured maximum — currently 2 attempts.

**Check 2 — Convention checks:**

TypeScript validation catches structural errors, but it can't catch semantic ones. For that, a second pass runs three convention checks:

| Check | Rule |
|---|---|
| No hardcoded credentials | Spec must not contain raw email or password strings |
| POM-only locators | `page.locator()` must not appear directly in the spec — only inside the Page Object Model |
| POM is used | The generated POM must be imported and actually used in the spec |

These rules exist because they're the most common ways a generated spec looks correct but isn't maintainable. Hardcoded credentials break when passwords rotate. Locators in specs bypass the abstraction layer entirely. A POM that was generated but never imported is dead code.

If any check fails, the violation gets fed back to the agent the same way TypeScript errors do — as a specific, actionable message. The agent fixes it and the checks run again.

```
Writer produces spec + POM
        │
        ├── tsc --noEmit ──── errors? → feed back → retry
        │
        └── Convention checks
              no hardcoded creds?
              no page.locator() in spec?
              POM imported and used?
                    │
                    └── violation? → feed back → retry
                              │
                              └── max attempts reached?
                                    → commit anyway, flag in TaskResult
```

One important detail: if all attempts fail, the spec is still committed. A flagged draft PR that needs human review is more useful than a silent failure. The `TaskResult` includes a warning, the PR description calls it out, and the QA engineer can fix it during review.

This is the same philosophy as the draft PR itself — the agent produces a candidate, the human makes the final call.

---

## 6. Human-in-the-Loop

Every generated spec opens as a **draft PR**. This is not a safety net or a temporary limitation until the AI gets better. It's a deliberate architectural decision.

Here's why it matters.

An AI agent browsing a web app can observe what's on the screen. It can collect locators, record flows, note what happens when a button is clicked. What it can't do is know whether the test it generated actually captures the intent behind the acceptance criteria. It can't know if a flow it observed is the expected behavior or a bug that slipped through. It can't know if the Page Object Model it wrote matches the naming conventions your team settled on six months ago.

Those are judgment calls. They belong to a human.

The draft PR is where that judgment gets applied. The QA engineer opens it, reads the spec like they'd review any other PR, and has three options:

1. **Approve and merge** — the spec is correct, CI will take it from here
2. **Request changes** — leave inline review comments on the spec
3. **Edit directly** — small fixes can go straight on the branch

Option 2 is where the feedback loop closes. When a reviewer submits `CHANGES_REQUESTED`, the trigger service picks up the review event, extracts the inline comments, and forwards them to the orchestrator's `/reviews` endpoint. The Review Agent reads the current spec, reads the reviewer's comments, fixes the code, and commits back to the same branch.

```
QA engineer reviews draft PR
        │
        ├── Approved → merge → CI runs
        │
        └── CHANGES_REQUESTED
              │
              ▼
        klikagent-github-trigger
        parses inline comments → ReviewContext
              │
              ▼
        Review Agent
        reads spec + comments → fixes code
        tsc validation → commit to branch
        bot replies to each comment
```

The reviewer gets a bot reply on each comment confirming it was addressed. If the fix looks good, they approve. If it still needs work, they comment again.

The human-in-the-loop isn't just about catching AI mistakes. It's also how domain knowledge flows back into the system. A reviewer who says "this test should also cover the case where the patient has no appointments" is teaching the agent something about the feature that wasn't in the original acceptance criteria. That correction lives in the git history and in the final spec, not just in someone's head.

The draft PR is the interface between the agent and the team. Keep it mandatory.

---

## 7. Challenges

Building KlikAgent was straightforward in concept and messy in practice. Here's what actually gave me trouble.

**Getting the browser automation layer right took several attempts.** The first version used the Playwright API directly. The second tried the Playwright MCP server — but execution was slow and token costs were significant, since each MCP tool call spins up its own context with no shared session state. The third switched to `@playwright/cli`. The fourth landed on `playwright-cli` — a persistent session wrapper that keeps browser state across tool calls without spawning a new process each time. Each switch was driven by a real problem: the direct API couldn't maintain session state cleanly across sequential agent calls, MCP was too expensive to run at scale, and the first CLI version had path resolution issues in Docker that took multiple attempts to fix. Getting Chromium installed correctly in the production container alone produced five separate commits.

**The self-correction loop was harder to get right than expected.** The first version fed all violations back to the agent at once. The problem: the agent would fix one violation and accidentally introduce another. The fix was to process violations one at a time, re-check after each fix, and only move on when clean. The regex lookbehind patterns for detecting `page.locator()` in specs also needed several iterations to avoid false positives on POM files.

**Stopping the agent from hardcoding credentials was genuinely difficult.** This sounds trivial but it isn't. The agent naturally reaches for the credentials it was given at the start of a run and writes them directly into specs. Getting it to consistently use the personas fixture instead required building a dynamic convention check that reads the actual persona values from config at runtime and checks the spec against them — not a static string match. Several commits were dedicated to getting this right, including cases where the persona cache was empty or env var fallbacks were incorrectly applied.

**Multi-tenant browser sessions caused subtle state pollution.** When two tasks run concurrently, they share a host process but need completely isolated browser sessions. Without explicit session scoping, one run's browser state would bleed into another's — wrong page, wrong auth, wrong locators. The fix was session IDs tied to run IDs, with an `activeSessions` set tracking what's open. This also required task locking at the orchestrator level to prevent duplicate runs.

**The AI provider situation was messier than expected.** The system was initially built assuming a swap-friendly provider layer. In practice, switching providers isn't just changing env vars — different models have different tool call behaviour, context window handling, and reliability profiles. Gemini was integrated and then fully reverted after it didn't hold up under the tool-heavy agent workloads. MiniMax M2.7 stuck because it handles long tool call loops reliably at 204k context.

**The whole architecture was redesigned once.** Halfway through, it became clear the original design — a monolithic agent with GitHub tightly coupled to the core — wasn't going to scale. The redesign introduced the `QATask` contract, separated the trigger adapter, moved to a proper HTTP API, and split the single agent into the Explorer/Writer pipeline. That was three refactor phases and a lot of deleted code. The commit history has a `remove dead code` commit that's doing a lot of work.

---

## 8. Known Constraints

KlikAgent works well enough to be useful, but there are honest limitations worth naming.

**The Explorer can miss things.** An agent navigating a web app doesn't know what it doesn't know. If a feature has an important edge case that only appears under specific conditions — a patient with no appointments, a doctor assigned to a closed department — the Explorer won't find it unless it deliberately navigates to that state. The generated spec will cover what the agent saw, not what the feature actually requires. That's why the acceptance criteria in the issue matter, and why human review is non-negotiable.

**Self-correction has a ceiling.** The loop catches TypeScript errors and convention violations, but it can't catch a logically wrong test. A spec that asserts the wrong thing and passes is worse than a failing test — it gives false confidence. The agent doesn't know what the correct behavior is; it knows what it observed. Those aren't always the same.

**The in-memory store doesn't survive restarts.** The trigger service stores the mapping between a `taskId` and the originating GitHub issue in memory. If the process restarts while a task is in flight, the callback won't know which issue to comment on. This is fine for a self-hosted single-team setup but would need a persistent store for anything more.

**The CI feedback loop is partially wired.** The infrastructure for CI to report test failures back to the orchestrator exists — `POST /tasks/:id/results` — but the full patch loop (agent reads failure output, fixes spec, commits) isn't complete yet. Right now, CI failures land in the dashboard but don't automatically trigger a fix. That's the next phase.

**It's one model, one provider.** The OpenAI-compatible SDK makes swapping providers easy, but the system has only been tested with MiniMax M2.7 at 204k context. A model with a smaller context window or weaker tool-call support will behave differently, and the prompts haven't been tuned for anything else.

**Fixture updates are append-only.** When the agent adds a new POM, it appends the import to `fixtures/index.ts`. It doesn't clean up, reorganize, or handle cases where a POM was renamed or removed. Over time, with enough generated PRs merging, the fixture file will need occasional manual housekeeping.

---

## 8. What's Next

KlikAgent is working, but it's not finished. A few things are clearly next.

**Closing the CI feedback loop.** The infrastructure is there — CI reports results to `POST /tasks/:id/results`, the orchestrator receives them. What's missing is the patch agent that reads the actual Playwright error output, understands which assertion failed and why, and commits a fix to the same branch. This is the most impactful thing on the roadmap. Right now a failing CI run requires manual intervention. With the loop closed, it becomes another iteration the agent handles automatically.

**Persistent storage.** Replacing the in-memory run store and issue ref store with something durable — even just a SQLite file — would make the system reliable across restarts and give the dashboard real historical data rather than only the current process lifetime.

**Broader model testing.** The system has been tested with MiniMax M2.7. Running it against other providers — Claude, GPT-4o, Gemini — would reveal which parts of the prompt design are model-specific and which are genuinely portable. The two-agent split and structured handoff should transfer well. The browser exploration prompts probably need tuning per model.

**Richer acceptance criteria parsing.** Right now the Explorer gets the raw acceptance criteria text and navigates based on it. A structured pre-processing step — turning criteria into explicit test scenarios before the Explorer runs — would give it clearer direction and reduce the chance of missing an important case.

**More trigger adapters.** The `QATask` interface is already provider-agnostic. A Jira adapter, a Linear adapter, or even a simple CLI trigger (`klikagent run --feature auth --description "..."`) would open the system to teams not using GitHub issues as their task source.

The core is solid. A two-agent pipeline with a typed handoff, a self-correction loop before commit, and a human review gate before merge — that structure holds up. What's left is closing the loops that are currently open and making it easier to run in more contexts.

---

If you're building something similar or have thoughts on the architecture, I'd love to hear from you. The full source is available at [github.com/mihaamiharu/klikagent](https://github.com/mihaamiharu/klikagent) — contributions, issues, and feedback are welcome.

If this was useful, follow along for the next parts: a deeper look at the two-agent pattern, and how the self-correction loop works in practice.
