# QA Agent: Prompt Decomposition, Parallel Tools & CLI Hardening

Reduce token cost by splitting the monolithic system prompt into phase-aware sections, add parallel tool execution for independent calls, and harden the CLI browser layer.

## Context

- **Current branch**: `fix/orchestrator-issue` (HEAD)
- The system prompt in `qaAgent.ts` is **~165 lines**, sent on every iteration (up to 80). Rules the model frequently ignores require convention checks as a safety net.
- Tool execution is sequential even for independent calls (e.g. 3-5 repo lookups on iteration 1).
- Browser tools work via `@playwright/cli` subprocess — **keeping this approach**, but hardening error handling.

---

## 1. System Prompt Decomposition

The current 165-line prompt contains instructions for **all phases** (exploration, code writing, validation), but the agent only needs ~30-40% of it at any given time.

### Phase Analysis

| Phase | When | Lines needed | Lines wasted |
|---|---|---|---|
| **Context gathering** | Iterations 1-2 (repo lookups) | Core + sequence = ~25 lines | ~140 lines of browser/spec/POM rules |
| **Exploration** | After first `browser_navigate` | Core + browser = ~90 lines | ~75 lines of spec/POM/validation rules |
| **Code generation** | After `browser_close` | Core + spec/POM = ~81 lines | ~84 lines of browser/validation rules |
| **Validation** | After first `validate_typescript` | Core + validation = ~31 lines | ~134 lines of browser/spec rules |

**Expected savings**: 40-80% fewer system prompt tokens per iteration depending on phase. Over 80 iterations, this compounds significantly.

### Prompt Sections

Split into 6 composable fragments in [NEW] `src/agents/prompts/sections.ts`:

```
CORE_ROLE          (~9 lines)   — "You are a senior QA engineer..." + job overview
FEATURE_AND_SEQUENCE (~16 lines) — Feature determination + required tool call sequence
BROWSER_TOOLS      (~65 lines)  — Browser tools, auth state, exploration workflow, locator strategy, browser_command
SPEC_RULES         (~30 lines)  — Spec writing rules, tagging, persona rules, POM usage
POM_RULES          (~22 lines)  — POM file conventions, fixture registration
VALIDATION_RULES   (~10 lines)  — validate_typescript + done() protocol, Playwright API gotchas
```

### Phase Detection

Track tool calls to detect phase transitions in the agent loop:

```
CONTEXT       → (default, no browser tools called yet)
EXPLORATION   → triggered when agent calls browser_navigate
CODE_GEN      → triggered when agent calls browser_close
VALIDATION    → triggered when agent calls validate_typescript
```

### Prompt Assembly Per Phase

```typescript
// CONTEXT:     CORE + FEATURE_AND_SEQUENCE + brief "you'll explore with browser tools, then write specs"
// EXPLORATION: CORE + BROWSER_TOOLS + FEATURE_AND_SEQUENCE
// CODE_GEN:    CORE + SPEC_RULES + POM_RULES + FEATURE_AND_SEQUENCE
// VALIDATION:  CORE + VALIDATION_RULES
```

> [!IMPORTANT]  
> The system message in OpenAI's API is the **first message** in the `messages` array. Changing it mid-loop means replacing `messages[0]` — the model still sees the full conversation history, but the instructions it follows shift to match the current phase.

### Files Changed

#### [NEW] [sections.ts](file:///home/mihaamiharu/klikagent/src/agents/prompts/sections.ts)

Contains all 6 prompt sections as exported string constants. Each section is self-contained and can be composed.

#### [NEW] [phasePrompt.ts](file:///home/mihaamiharu/klikagent/src/agents/prompts/phasePrompt.ts)

Phase detection + prompt assembly logic:

```typescript
type AgentPhase = 'context' | 'exploration' | 'code_gen' | 'validation';

export function detectPhase(calledTools: string[]): AgentPhase;
export function buildSystemPrompt(phase: AgentPhase): string;
```

#### [MODIFY] [ai.ts](file:///home/mihaamiharu/klikagent/src/services/ai.ts)

Add optional `onPhaseChange` callback to `RunAgentOptions`:

```typescript
export interface RunAgentOptions {
  // ... existing fields
  onToolCall?: (toolName: string) => string | null;  // returns new system prompt if phase changed, null otherwise
}
```

Inside the tool loop, after each tool call:
1. Call `onToolCall(toolName)` 
2. If it returns a new system prompt, replace `messages[0].content`
3. Log the phase transition

#### [MODIFY] [qaAgent.ts](file:///home/mihaamiharu/klikagent/src/agents/qaAgent.ts)

- Remove the monolithic `SYSTEM_PROMPT` constant
- Import phase detection and prompt assembly
- Pass `onToolCall` callback to `runAgent()` that uses `detectPhase` + `buildSystemPrompt`
- Initial system prompt = `buildSystemPrompt('context')`

---

## 2. Parallel Tool Execution

#### [MODIFY] [ai.ts](file:///home/mihaamiharu/klikagent/src/services/ai.ts)

Replace the sequential `for` loop (L149-196) with a parallel-aware executor:

```typescript
// Tools that MUST run sequentially (stateful browser session + terminal actions)
const SEQUENTIAL_TOOLS = new Set([
  'browser_navigate', 'browser_click', 'browser_fill',
  'browser_snapshot', 'browser_list_interactables',
  'browser_generate_locator', 'browser_eval',
  'browser_command', 'browser_close',
  'done',
]);
```

**Strategy**: Simple and safe —

```typescript
const toolCalls = assistantMessage.tool_calls.filter(tc => tc.type === 'function');
const hasSequential = toolCalls.some(tc => SEQUENTIAL_TOOLS.has(tc.function.name));

if (hasSequential) {
  // Any sequential tool → run ALL sequentially (preserve ordering)
  for (const tc of toolCalls) { /* existing sequential logic */ }
} else {
  // All parallel-safe → run with Promise.all
  const results = await Promise.all(
    toolCalls.map(tc => executeToolCall(tc, toolHandlers, toolCache, UNCACHEABLE_TOOLS))
  );
}
```

**Why this simple partitioning**: The model batches tool calls into two patterns:
- **Repo lookups**: `get_context_docs` + `get_fixtures` + `get_personas` — all independent, 3-5x speedup
- **Browser interactions**: `browser_click` + `browser_snapshot` — must be ordered

If any sequential tool appears in a batch, we run everything sequentially. This is conservative but correct — the model rarely mixes repo lookups with browser clicks in the same tool call batch.

Extract the per-tool execution logic into a helper:

```typescript
async function executeToolCall(
  toolCall: ToolCall,
  handlers: ToolHandlers,
  cache: Map<string, string>,
  uncacheable: Set<string>,
): Promise<{ id: string; result: string }>;
```

This also cleans up the loop body — the `done()` check, cache logic, and error handling move into the helper.

**Expected improvement**: 3-5x faster on iteration 1 (3-5 parallel GitHub API calls), ~2x faster whenever repo tools are batched.

---

## 3. CLI Hardening

Small, targeted improvements to `browserTools.ts` — no architecture changes.

#### [MODIFY] [browserTools.ts](file:///home/mihaamiharu/klikagent/src/services/browserTools.ts)

**3a. Structured error classification**

Replace raw stderr pass-through with classified errors:

```typescript
interface BrowserError {
  error: 'TIMEOUT' | 'SESSION_DEAD' | 'ELEMENT_NOT_FOUND' | 'BROWSER_ERROR';
  message: string;
  hint?: string;  // recovery suggestion for the agent
}

function classifyError(output: string): BrowserError {
  if (output.includes('Timeout')) return { error: 'TIMEOUT', message: output, hint: 'The page may be loading slowly. Try browser_snapshot() to check current state.' };
  if (output.includes('not found') || output.includes('No element')) return { error: 'ELEMENT_NOT_FOUND', message: output, hint: 'The element ref may be stale. Call browser_snapshot() to get fresh refs.' };
  // ... etc
  return { error: 'BROWSER_ERROR', message: output };
}
```

**3b. Configurable timeout**

```typescript
const CLI_TIMEOUT = parseInt(process.env.BROWSER_CLI_TIMEOUT ?? '30000', 10);
```

**3c. Session state encapsulation**

Wrap `sessionActive` into a lightweight object for future concurrency:

```typescript
interface SessionState {
  active: boolean;
  sessionId: string;
  startedAt?: Date;
}

// Module-level, but now a named object instead of a bare boolean
let session: SessionState = { active: false, sessionId: 'klikagent' };
```

This doesn't change behavior today but makes it straightforward to add per-task session IDs later.

---

## Verification Plan

### Automated Tests
```bash
npm run build    # TypeScript compilation
npm test         # All existing tests must pass
```

- Update `ai.test.ts`: add tests for parallel execution (batch of non-sequential tools) and sequential fallback (batch containing a browser tool)
- Update `qaAgent.test.ts`: verify the system prompt is assembled from sections, not a monolith
- Add `src/agents/prompts/phasePrompt.test.ts`: test phase detection state machine
- Update `browserTools.test.ts`: verify error classification returns structured errors

### Manual Verification
- Run a local task with `curl POST /tasks` to verify full flow still works end-to-end
- Compare token usage logs (before/after) to validate prompt decomposition savings
